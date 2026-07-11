import { nextRun } from "@registry/cron";
import { events } from "@registry/notifications";
import {
  type CleanupRule,
  type ManifestState,
  type TagState,
  effectiveUntaggedTtl,
  evaluateCleanup,
  evaluateUntagged,
} from "@registry/retention";
import type { Env } from "../env.js";
import { notify } from "../notifications/dispatch.js";
import { ProjectPolicy } from "../policy.js";
import { ProjectStore } from "../storage/projects.js";
import { SignatureIndex } from "../storage/signatures.js";
import { TagIndex } from "../storage/tags.js";
import { Retirer } from "./retire.js";

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
 *
 * One retirer serves the whole run: it caches each project's rules across the
 * policies it retires from, and every deletion - tag or manifest - goes through
 * its single path, which consults the same immutability guard the API's delete
 * endpoints consult rather than re-deriving it.
 */
export async function runDueCleanups(env: Env, now = Date.now()): Promise<CleanupReport[]> {
  const due = await env.DB.prepare(
    `SELECT project, schedule, rules, untagged_older_than_days
     FROM cleanup_policies
     WHERE enabled = 1 AND next_run_at IS NOT NULL AND next_run_at <= ?
     ORDER BY next_run_at ASC
     LIMIT ?`,
  )
    .bind(now, MAX_POLICIES_PER_RUN)
    .all<PolicyRow>();

  const retirer = new Retirer(
    env.DB,
    new ProjectPolicy(new ProjectStore(env.DB), new SignatureIndex(env.DB), new TagIndex(env.DB)),
  );

  const reports: CleanupReport[] = [];
  for (const policy of due.results) {
    await reschedule(env, policy.project, policy.schedule, now);
    reports.push(await runPolicy(env, retirer, policy, now));
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

async function runPolicy(env: Env, retirer: Retirer, policy: PolicyRow, now: number): Promise<CleanupReport> {
  const rules = parseRules(policy.rules);

  const repositories = await env.DB.prepare("SELECT name FROM repositories WHERE project = ?")
    .bind(policy.project)
    .all<{ name: string }>();

  // Immutability is not re-derived here: every tag the rules doom is offered to
  // the shared guard, which refuses a tag a project has frozen exactly as the
  // API refuses it. A project that enforces immutability therefore retires none.
  let tagsRemoved = 0;
  for (const { name } of repositories.results) {
    if (tagsRemoved >= MAX_DELETIONS_PER_POLICY) break;
    tagsRemoved += await cleanRepository(env, retirer, policy.project, name, rules, now);
  }

  // The project-level column sweeps every repository at one TTL; it is untouched
  // here and folds into an untagged rule only when the lifecycle migration lands.
  let untaggedRemoved =
    policy.untagged_older_than_days === null || policy.untagged_older_than_days <= 0
      ? 0
      : await retireUntagged(env, retirer, policy.project, policy.untagged_older_than_days, now);

  // Untagged rules retire per repository. An untagged manifest has no tag for
  // immutability to protect, so the guard permits it whatever the project's setting.
  for (const { name } of repositories.results) {
    if (untaggedRemoved >= MAX_DELETIONS_PER_POLICY) break;
    untaggedRemoved += await retireUntaggedByRule(
      env,
      retirer,
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

  await announceCleanup(env, policy.project, tagsRemoved, untaggedRemoved, now);

  return { project: policy.project, tagsRemoved, untaggedRemoved };
}

/**
 * Tells the project's subscribed policies what one cleanup run removed.
 *
 * One event per run, not per deletion, and only when the run retired something:
 * a run that touched nothing is not news. Best-effort, like every other
 * notification - the retirements are already recorded, so a webhook that cannot
 * be queued must not fail the run.
 */
async function announceCleanup(
  env: Env,
  project: string,
  tagsRemoved: number,
  untaggedRemoved: number,
  now: number,
): Promise<void> {
  if (tagsRemoved + untaggedRemoved === 0) return;

  try {
    await notify(env, events.CLEANUP({ project, at: now, data: { tagsRemoved, untaggedRemoved } }));
  } catch (error) {
    console.error("failed to announce cleanup", { project, error });
  }
}

async function cleanRepository(
  env: Env,
  retirer: Retirer,
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

  // Only the tag is removed. The manifest survives until it is untagged for
  // long enough, or until garbage collection finds nothing pointing at it.
  let removed = 0;
  for (const tag of doomed) {
    if (await retirer.retireTag(project, repository, tag.name, tag.reason, now)) removed++;
  }
  return removed;
}

/**
 * Retires the untagged manifests the project-level TTL column governs.
 *
 * An untagged manifest is usually a superseded image, but it may equally be a
 * signature or an SBOM - attached artifacts are untagged by design - or a
 * platform manifest inside a multi-architecture index. Deleting either would
 * silently break the thing that points at it, so the query spares all three.
 */
async function retireUntagged(
  env: Env,
  retirer: Retirer,
  project: string,
  ttlDays: number,
  now: number,
): Promise<number> {
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

  let removed = 0;
  for (const { repository, digest } of candidates.results) {
    const reason = `untagged for more than ${ttlDays} days`;
    if (await retirer.retireManifest(project, repository, digest, reason, now)) removed++;
  }
  return removed;
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
  retirer: Retirer,
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
  let removed = 0;
  for (const manifest of doomed) {
    if (await retirer.retireManifest(project, repository, manifest.name, manifest.reason, now)) removed++;
  }
  return removed;
}
