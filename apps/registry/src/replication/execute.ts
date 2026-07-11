import { isValidRepositoryName } from "@registry/oci";
import { events, isPublicHttpsUrl } from "@registry/notifications";
import { projectOf } from "@registry/projects";
import {
  type RegistryClient,
  type ReplicationRule,
  RemoteRegistry,
  copyArtifact,
  remap,
  ruleMatchesRepository,
  ruleMatchesTag,
} from "@registry/replication";
import type { Env } from "../env.js";
import { ProjectPolicy } from "../policy.js";
import { R2ContentStore } from "../storage/content.js";
import { D1MetadataStore } from "../storage/metadata.js";
import { ProjectStore } from "../storage/projects.js";
import { SignatureIndex } from "../storage/signatures.js";
import { TagIndex } from "../storage/tags.js";
import { notify } from "../notifications/dispatch.js";
import { LocalRegistry } from "./local.js";
import { ReplicationStore } from "./store.js";

export const REPLICATE_TASK = "replication.run";

/** Bounds one rule's run, which shares a Worker invocation with everything else. */
const MAX_ARTIFACTS_PER_RUN = 50;

export interface ReplicatePayload {
  readonly ruleId: string;
  /** Set when a push event triggered this run; absent for a full sweep. */
  readonly repository?: string;
  readonly reference?: string;
}

export function localRegistry(env: Env): LocalRegistry {
  return new LocalRegistry(
    new D1MetadataStore(env.DB),
    new R2ContentStore(env.BUCKET),
    new ProjectPolicy(new ProjectStore(env.DB), new SignatureIndex(env.DB), new TagIndex(env.DB)),
  );
}

async function remoteRegistry(store: ReplicationStore, rule: ReplicationRule) {
  const credentials = await store.credentials(rule.id);
  return new RemoteRegistry({
    url: rule.remoteUrl,
    // A project owner chose this URL, so the registry vets the base, every
    // redirect, and the token realm against the same filter a webhook target
    // passes - it must not become a way to reach the internal network.
    guard: isPublicHttpsUrl,
    ...(credentials === null ? {} : { credentials }),
  });
}

/** What one run copied, and how it fared, so the run can announce itself. */
interface RunOutcome {
  manifests: number;
  blobs: number;
  copied: number;
  failed: number;
  firstError: string | null;
}

function outcome(): RunOutcome {
  return { manifests: 0, blobs: 0, copied: 0, failed: 0, firstError: null };
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * Copies one artifact and records the outcome, whichever way it went.
 *
 * A single artifact's failure does not abort the rule. A rule that mirrors
 * thirty images should not stop at the one whose upstream tag was deleted a
 * minute ago.
 */
async function copyOne(
  store: ReplicationStore,
  rule: ReplicationRule,
  source: RegistryClient,
  destination: RegistryClient,
  sourceRepository: string,
  destinationRepository: string,
  reference: string,
  run: RunOutcome,
): Promise<void> {
  try {
    const report = await copyArtifact(
      source,
      destination,
      sourceRepository,
      destinationRepository,
      reference,
    );
    run.manifests += report.manifests;
    run.blobs += report.blobs;
    run.copied++;

    await store.recordExecution({
      ruleId: rule.id,
      project: rule.project,
      status: "succeeded",
      repository: sourceRepository,
      reference,
      manifests: report.manifests,
      blobs: report.blobs,
      error: null,
    });
  } catch (error) {
    run.failed++;
    run.firstError ??= messageOf(error);
    await store.recordExecution({
      ruleId: rule.id,
      project: rule.project,
      status: "failed",
      repository: sourceRepository,
      reference,
      manifests: 0,
      blobs: 0,
      error: messageOf(error),
    });
  }
}

/** Sends this project's matching artifacts to the far registry. */
async function runPush(env: Env, store: ReplicationStore, rule: ReplicationRule, payload: ReplicatePayload) {
  const local = localRegistry(env);
  const remote = await remoteRegistry(store, rule);
  const run = outcome();

  // One artifact, named by the push that triggered this.
  if (payload.repository !== undefined && payload.reference !== undefined) {
    if (!ruleMatchesRepository(rule, payload.repository) || !ruleMatchesTag(rule, payload.reference)) {
      return run;
    }
    await copyOne(
      store,
      rule,
      local,
      remote,
      payload.repository,
      remap(payload.repository, rule.destinationNamespace),
      payload.reference,
      run,
    );
    return run;
  }

  const repositories = await env.DB.prepare("SELECT name FROM repositories WHERE project = ?")
    .bind(rule.project)
    .all<{ name: string }>();

  let copied = 0;
  for (const { name } of repositories.results) {
    if (!ruleMatchesRepository(rule, name)) continue;

    for (const tag of await local.listTags(name)) {
      if (copied >= MAX_ARTIFACTS_PER_RUN) return run;
      if (!ruleMatchesTag(rule, tag)) continue;

      await copyOne(store, rule, local, remote, name, remap(name, rule.destinationNamespace), tag, run);
      copied++;
    }
  }
  return run;
}

/**
 * Copies matching artifacts from the far registry into this project.
 *
 * The destination repository always lands inside the rule's own project,
 * whatever the remote calls itself. Anything else would let a pull rule write
 * into a project its owner does not administer.
 */
async function runPull(env: Env, store: ReplicationStore, rule: ReplicationRule) {
  const local = localRegistry(env);
  const remote = await remoteRegistry(store, rule);
  const run = outcome();

  let copied = 0;
  for (const sourceRepository of rule.sourceRepositories) {
    const destination = destinationFor(rule, sourceRepository);
    if (destination === null) continue;

    let tags: string[];
    try {
      tags = await remote.listTags(sourceRepository);
    } catch (error) {
      run.failed++;
      run.firstError ??= messageOf(error);
      await store.recordExecution({
        ruleId: rule.id,
        project: rule.project,
        status: "failed",
        repository: sourceRepository,
        reference: null,
        manifests: 0,
        blobs: 0,
        error: messageOf(error),
      });
      continue;
    }

    for (const tag of tags) {
      if (copied >= MAX_ARTIFACTS_PER_RUN) return run;
      if (!ruleMatchesTag(rule, tag)) continue;

      await copyOne(store, rule, remote, local, sourceRepository, destination, tag, run);
      copied++;
    }
  }
  return run;
}

/**
 * Where a remote repository lands locally: inside the rule's project, under the
 * last segment of the remote name.
 *
 * `library/alpine` pulled by project `mirror` becomes `mirror/alpine`. Null when
 * the result would not be a valid repository name, or - the check that matters -
 * would not land in this project at all.
 */
export function destinationFor(rule: ReplicationRule, sourceRepository: string): string | null {
  const segments = sourceRepository.split("/");
  const leaf = segments.at(-1);
  if (leaf === undefined || leaf === "") return null;

  const namespace = rule.destinationNamespace.replace(/^\/+|\/+$/g, "");
  const path = namespace === "" ? leaf : `${namespace}/${leaf}`;
  const destination = `${rule.project}/${path}`;

  if (!isValidRepositoryName(destination)) return null;
  if (projectOf(destination) !== rule.project) return null;
  return destination;
}

/** The task the queue runs. Throwing schedules a retry; returning closes the task. */
export async function handleReplicateTask(payload: unknown, env: Env): Promise<void> {
  if (typeof payload !== "object" || payload === null) throw new Error("malformed replication payload");
  const input = payload as ReplicatePayload;
  if (typeof input.ruleId !== "string") throw new Error("malformed replication payload");

  const store = new ReplicationStore(env.DB, env.JWT_SECRET);
  const rule = await store.get(input.ruleId);
  // Deleted between the enqueue and the run.
  if (rule === null || !rule.enabled) return;

  const run =
    rule.direction === "push" ? await runPush(env, store, rule, input) : await runPull(env, store, rule);
  await store.recordResult(rule, JSON.stringify({ manifests: run.manifests, blobs: run.blobs }));

  // Best-effort, like every other notification: the run already happened, so a
  // webhook that cannot be queued must not force the whole copy to run again.
  try {
    await announceReplication(env, rule, input, run);
  } catch (error) {
    console.error("failed to announce replication", { rule: rule.id, error });
  }
}

/**
 * Tells the project's subscribed policies what a replication run did.
 *
 * One event per run, and only when there is news: a run that matched nothing
 * copied and failed nothing, and is silent. A run that copied or failed at least
 * one artifact announces itself, and a failure names the first error so a broken
 * mirror is visible without reading the task tables.
 */
async function announceReplication(
  env: Env,
  rule: ReplicationRule,
  payload: ReplicatePayload,
  run: RunOutcome,
): Promise<void> {
  if (run.copied === 0 && run.failed === 0) return;

  const event = events.REPLICATION({
    project: rule.project,
    ...(payload.repository === undefined ? {} : { repository: payload.repository }),
    at: Date.now(),
    data: {
      rule: rule.name,
      status: run.failed > 0 ? "failed" : "succeeded",
      manifests: run.manifests,
      blobs: run.blobs,
      ...(run.firstError === null ? {} : { error: run.firstError }),
    },
  });
  await notify(env, event);
}

/** Runs the scheduled rules that have come due. */
export async function runDueReplications(env: Env, now = Date.now()): Promise<number> {
  const store = new ReplicationStore(env.DB, env.JWT_SECRET);
  const due = await store.due(now, 5);

  for (const rule of due) {
    // Before the work, so a rule that dies does not immediately run again.
    await store.reschedule(rule, now);
    try {
      await handleReplicateTask({ ruleId: rule.id }, env);
    } catch (error) {
      console.error("scheduled replication failed", { rule: rule.id, error });
    }
  }
  return due.length;
}
