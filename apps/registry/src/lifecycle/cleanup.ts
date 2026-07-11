import { nextRun } from "@registry/cron";
import { projectOf } from "@registry/projects";
import {
  type CleanupRule,
  type ManifestState,
  type TagState,
  effectiveUntaggedTtl,
  evaluateCleanup,
  evaluateUntagged,
} from "@registry/retention";
import type { Env } from "../env.js";

const DAY_MS = 86_400_000;

/** Bounds a single cron invocation, which shares a Worker's CPU budget with everything else. */
const MAX_POLICIES_PER_RUN = 20;
const MAX_DELETIONS_PER_POLICY = 500;

export interface CleanupReport {
  readonly project: string;
  readonly tagsRemoved: number;
  readonly untaggedRemoved: number;
}

interface PolicyRow {
  project: string;
  schedule: string;
  rules: string;
  untagged_older_than_days: number | null;
  immutable_tags: number;
}

function parseRules(raw: string): CleanupRule[] {
  try {
    const parsed: unknown = JSON.parse(raw);
    return Array.isArray(parsed) ? (parsed as CleanupRule[]) : [];
  } catch {
    return [];
  }
}

/**
 * Runs every cleanup policy that has come due.
 *
 * `next_run_at` is advanced before the work rather than after it. A run that
 * dies half way through has still consumed its slot, and the alternative - a
 * policy that retries immediately, forever - is how a bug in one project's
 * rules starves every other project's.
 */
export async function runDueCleanups(env: Env, now = Date.now()): Promise<CleanupReport[]> {
  const due = await env.DB.prepare(
    `SELECT c.project, c.schedule, c.rules, c.untagged_older_than_days, p.immutable_tags
     FROM cleanup_policies AS c
     JOIN projects AS p ON p.name = c.project
     WHERE c.enabled = 1 AND c.next_run_at IS NOT NULL AND c.next_run_at <= ?
     ORDER BY c.next_run_at ASC
     LIMIT ?`,
  )
    .bind(now, MAX_POLICIES_PER_RUN)
    .all<PolicyRow>();

  const reports: CleanupReport[] = [];
  for (const policy of due.results) {
    await reschedule(env, policy.project, policy.schedule, now);
    reports.push(await runPolicy(env, policy, now));
  }
  return reports;
}

/** Recomputes when a policy next fires. Also called when its schedule is set. */
export async function reschedule(env: Env, project: string, schedule: string, now: number): Promise<void> {
  const next = nextRun(schedule, now);
  await env.DB.prepare("UPDATE cleanup_policies SET next_run_at = ? WHERE project = ?")
    .bind(next, project)
    .run();
}

async function runPolicy(env: Env, policy: PolicyRow, now: number): Promise<CleanupReport> {
  const rules = parseRules(policy.rules);

  const repositories = await env.DB.prepare("SELECT name FROM repositories WHERE project = ?")
    .bind(policy.project)
    .all<{ name: string }>();

  // A project that enforces immutable tags retires none of them, whatever its
  // rules say. A promise that a cron may quietly retract is not a promise. The
  // untagged sweep below still runs: an untagged manifest has no tag to protect.
  let tagsRemoved = 0;
  if (policy.immutable_tags !== 1) {
    for (const { name } of repositories.results) {
      if (tagsRemoved >= MAX_DELETIONS_PER_POLICY) break;
      tagsRemoved += await cleanRepository(env, policy.project, name, rules, now);
    }
  }

  // The project-level column sweeps every repository at one TTL; it is untouched
  // here and folds into an untagged rule only when the lifecycle migration lands.
  let untaggedRemoved =
    policy.untagged_older_than_days === null || policy.untagged_older_than_days <= 0
      ? 0
      : await retireUntagged(env, policy.project, policy.untagged_older_than_days, now);

  // Untagged rules retire per repository, whatever the project's immutable-tags
  // setting: an untagged manifest has no tag for that promise to protect.
  for (const { name } of repositories.results) {
    if (untaggedRemoved >= MAX_DELETIONS_PER_POLICY) break;
    untaggedRemoved += await retireUntaggedByRule(
      env,
      policy.project,
      name,
      rules,
      now,
      MAX_DELETIONS_PER_POLICY - untaggedRemoved,
    );
  }

  const result = JSON.stringify({ tagsRemoved, untaggedRemoved });
  await env.DB.prepare("UPDATE cleanup_policies SET last_run_at = ?, last_result = ? WHERE project = ?")
    .bind(now, result, policy.project)
    .run();

  return { project: policy.project, tagsRemoved, untaggedRemoved };
}

async function cleanRepository(
  env: Env,
  project: string,
  repository: string,
  rules: readonly CleanupRule[],
  now: number,
): Promise<number> {
  const rows = await env.DB.prepare("SELECT name, updated_at FROM tags WHERE repository = ?")
    .bind(repository)
    .all<{ name: string; updated_at: number }>();

  const tags: TagState[] = rows.results.map((row) => ({ name: row.name, updatedAt: row.updated_at }));
  const doomed = evaluateCleanup({ repository, tags, rules, now }).slice(0, MAX_DELETIONS_PER_POLICY);

  for (const tag of doomed) {
    await env.DB.batch([
      env.DB.prepare("DELETE FROM tags WHERE repository = ? AND name = ?").bind(repository, tag.name),
      env.DB.prepare(
        `INSERT INTO lifecycle_events (project, repository, action, subject, reason, created_at)
         VALUES (?, ?, 'retire-tag', ?, ?, ?)`,
      ).bind(project, repository, tag.name, tag.reason, now),
    ]);
  }

  // Only the tag is removed. The manifest survives until it is untagged for
  // long enough, or until garbage collection finds nothing pointing at it.
  return doomed.length;
}

/**
 * Removes manifests nothing points at any more.
 *
 * An untagged manifest is usually a superseded image, but it may equally be a
 * signature or an SBOM - attached artifacts are untagged by design - or a
 * platform manifest inside a multi-architecture index. Deleting either would
 * silently break the thing that points at it, so both are protected here, the
 * same way the nightly sweep protects them.
 */
async function retireUntagged(env: Env, project: string, ttlDays: number, now: number): Promise<number> {
  const cutoff = now - ttlDays * DAY_MS;

  const candidates = await env.DB.prepare(
    `SELECT m.repository, m.digest
     FROM manifests AS m
     JOIN repositories AS r ON r.name = m.repository
     WHERE r.project = ?
       AND m.created_at < ?
       AND NOT EXISTS (
         SELECT 1 FROM tags AS t WHERE t.repository = m.repository AND t.manifest_digest = m.digest
       )
       AND NOT EXISTS (
         SELECT 1 FROM manifest_children AS c
         JOIN manifests AS parent ON parent.repository = c.repository AND parent.digest = c.manifest_digest
         WHERE c.repository = m.repository AND c.child_digest = m.digest
       )
       AND NOT EXISTS (
         SELECT 1 FROM manifests AS subject
         WHERE m.subject_digest IS NOT NULL
           AND subject.repository = m.repository
           AND subject.digest = m.subject_digest
       )
     LIMIT ?`,
  )
    .bind(project, cutoff, MAX_DELETIONS_PER_POLICY)
    .all<{ repository: string; digest: string }>();

  for (const { repository, digest } of candidates.results) {
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
        `INSERT INTO lifecycle_events (project, repository, action, subject, reason, created_at)
         VALUES (?, ?, 'retire-manifest', ?, ?, ?)`,
      ).bind(projectOf(repository), repository, digest, `untagged for more than ${ttlDays} days`, now),
    ]);
  }

  return candidates.results.length;
}

/**
 * Retires the untagged manifests an untagged rule governs in one repository.
 *
 * The rule package decides what is doomed: the effective TTL is the strictest of
 * the overlapping rules, and a protected manifest is spared whatever the TTL. A
 * manifest is protected when a tag still points at it, when it is a platform
 * manifest inside an index that still exists, or when it is a signature or SBOM
 * whose subject still exists - the same three protections the project-level sweep
 * applies, so the two paths cannot drift.
 */
async function retireUntaggedByRule(
  env: Env,
  project: string,
  repository: string,
  rules: readonly CleanupRule[],
  now: number,
  budget: number,
): Promise<number> {
  const ttlDays = effectiveUntaggedTtl(repository, rules);
  if (ttlDays === null) return 0;

  const cutoff = now - ttlDays * DAY_MS;
  const rows = await env.DB.prepare(
    `SELECT m.digest, m.created_at AS pushed_at,
            CASE WHEN EXISTS (
              SELECT 1 FROM manifest_children AS c
              JOIN manifests AS parent
                ON parent.repository = c.repository AND parent.digest = c.manifest_digest
              WHERE c.repository = m.repository AND c.child_digest = m.digest
            ) OR EXISTS (
              SELECT 1 FROM manifests AS subject
              WHERE m.subject_digest IS NOT NULL
                AND subject.repository = m.repository
                AND subject.digest = m.subject_digest
            ) THEN 1 ELSE 0 END AS protected_flag
     FROM manifests AS m
     WHERE m.repository = ?
       AND m.created_at < ?
       AND NOT EXISTS (
         SELECT 1 FROM tags AS t WHERE t.repository = m.repository AND t.manifest_digest = m.digest
       )
     LIMIT ?`,
  )
    .bind(repository, cutoff, budget)
    .all<{ digest: string; pushed_at: number; protected_flag: number }>();

  const manifests: ManifestState[] = rows.results.map((row) => ({
    digest: row.digest,
    pushedAt: row.pushed_at,
    protected: row.protected_flag === 1,
  }));

  const doomed = evaluateUntagged({ repository, manifests, rules, now });
  for (const manifest of doomed) {
    await env.DB.batch([
      env.DB.prepare("DELETE FROM manifest_blobs WHERE repository = ? AND manifest_digest = ?").bind(
        repository,
        manifest.name,
      ),
      env.DB.prepare("DELETE FROM manifest_children WHERE repository = ? AND manifest_digest = ?").bind(
        repository,
        manifest.name,
      ),
      env.DB.prepare("DELETE FROM manifests WHERE repository = ? AND digest = ?").bind(
        repository,
        manifest.name,
      ),
      env.DB.prepare(
        `INSERT INTO lifecycle_events (project, repository, action, subject, reason, created_at)
         VALUES (?, ?, 'retire-manifest', ?, ?, ?)`,
      ).bind(project, repository, manifest.name, manifest.reason, now),
    ]);
  }

  return doomed.length;
}
