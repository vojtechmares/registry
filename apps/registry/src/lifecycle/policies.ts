import { integer, type Env } from "../env.js";

const DAY_MS = 24 * 60 * 60 * 1000;

/** Bounds the work a single cron invocation performs. */
const MAX_MANIFESTS_PER_RUN = 500;
const MAX_TAGS_PER_RUN = 500;

export interface LifecycleReport {
  readonly untaggedManifestsRemoved: number;
  readonly tagsRemoved: number;
}

interface PolicyRow {
  repository: string;
  keep_last_tags: number | null;
  untagged_ttl_days: number | null;
}

/**
 * Retires content according to per-repository policy.
 *
 * The interesting question is which untagged manifests are actually garbage.
 * An untagged manifest is usually a superseded image, but it may equally be a
 * signature or an SBOM - attached artifacts are untagged *by design* - or a
 * platform-specific manifest referenced by a multi-arch index. Deleting either
 * would silently break the thing that points at it, so both are protected.
 */
export async function runLifecycle(env: Env): Promise<LifecycleReport> {
  const defaultTtlDays = integer(env.UNTAGGED_MANIFEST_TTL_DAYS, 0);

  const policies = await env.DB.prepare(
    "SELECT repository, keep_last_tags, untagged_ttl_days FROM lifecycle_policies WHERE enabled = 1",
  ).all<PolicyRow>();

  let untaggedManifestsRemoved = 0;
  let tagsRemoved = 0;

  // A registry-wide default applies to every repository that has no policy row.
  if (defaultTtlDays > 0) {
    const configured = new Set(policies.results.map((policy) => policy.repository));
    const repositories = await env.DB.prepare("SELECT name FROM repositories").all<{ name: string }>();
    for (const { name } of repositories.results) {
      if (configured.has(name)) continue;
      untaggedManifestsRemoved += await retireUntagged(env, name, defaultTtlDays);
    }
  }

  for (const policy of policies.results) {
    if (policy.keep_last_tags !== null && policy.keep_last_tags > 0) {
      tagsRemoved += await trimTags(env, policy.repository, policy.keep_last_tags);
    }
    const ttlDays = policy.untagged_ttl_days ?? defaultTtlDays;
    if (ttlDays > 0) {
      untaggedManifestsRemoved += await retireUntagged(env, policy.repository, ttlDays);
    }
  }

  return { untaggedManifestsRemoved, tagsRemoved };
}

async function retireUntagged(env: Env, repository: string, ttlDays: number): Promise<number> {
  const cutoff = Date.now() - ttlDays * DAY_MS;

  const candidates = await env.DB.prepare(
    `SELECT m.digest
     FROM manifests AS m
     WHERE m.repository = ?
       AND m.created_at < ?
       -- Not reachable from a tag.
       AND NOT EXISTS (
         SELECT 1 FROM tags AS t
         WHERE t.repository = m.repository AND t.manifest_digest = m.digest
       )
       -- Not a platform manifest inside an index that still exists.
       AND NOT EXISTS (
         SELECT 1 FROM manifest_children AS c
         JOIN manifests AS parent
           ON parent.repository = c.repository AND parent.digest = c.manifest_digest
         WHERE c.repository = m.repository AND c.child_digest = m.digest
       )
       -- Not an artifact attached to a subject that still exists. Signatures
       -- and SBOMs are untagged by design and must outlive their own age limit.
       AND NOT EXISTS (
         SELECT 1 FROM manifests AS subject
         WHERE m.subject_digest IS NOT NULL
           AND subject.repository = m.repository
           AND subject.digest = m.subject_digest
       )
     LIMIT ?`,
  )
    .bind(repository, cutoff, MAX_MANIFESTS_PER_RUN)
    .all<{ digest: string }>();

  for (const { digest } of candidates.results) {
    await env.DB.batch([
      env.DB.prepare("DELETE FROM manifest_blobs WHERE repository = ? AND manifest_digest = ?").bind(
        repository,
        digest,
      ),
      env.DB.prepare("DELETE FROM manifest_children WHERE repository = ? AND manifest_digest = ?").bind(
        repository,
        digest,
      ),
      env.DB.prepare("DELETE FROM manifests WHERE repository = ? AND digest = ?").bind(repository, digest),
      env.DB.prepare(
        "INSERT INTO lifecycle_events (repository, action, subject, reason, created_at) VALUES (?,?,?,?,?)",
      ).bind(repository, "retire-manifest", digest, `untagged for more than ${ttlDays} days`, Date.now()),
    ]);
  }

  return candidates.results.length;
}

/** Keeps the `keep` most recently updated tags, removing the rest. */
async function trimTags(env: Env, repository: string, keep: number): Promise<number> {
  const doomed = await env.DB.prepare(
    `SELECT name FROM tags
     WHERE repository = ?
     ORDER BY updated_at DESC, name DESC
     LIMIT ? OFFSET ?`,
  )
    .bind(repository, MAX_TAGS_PER_RUN, keep)
    .all<{ name: string }>();

  for (const { name } of doomed.results) {
    await env.DB.batch([
      env.DB.prepare("DELETE FROM tags WHERE repository = ? AND name = ?").bind(repository, name),
      env.DB.prepare(
        "INSERT INTO lifecycle_events (repository, action, subject, reason, created_at) VALUES (?,?,?,?,?)",
      ).bind(repository, "retire-tag", name, `beyond the newest ${keep} tags`, Date.now()),
    ]);
  }

  return doomed.results.length;
}
