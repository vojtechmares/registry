import { isValidRepositoryName } from "@registry/oci";
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
    new ProjectPolicy(new ProjectStore(env.DB), new SignatureIndex(env.DB)),
  );
}

async function remoteRegistry(store: ReplicationStore, rule: ReplicationRule) {
  const credentials = await store.credentials(rule.id);
  return new RemoteRegistry({
    url: rule.remoteUrl,
    ...(credentials === null ? {} : { credentials }),
  });
}

interface Totals {
  manifests: number;
  blobs: number;
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
  totals: Totals,
): Promise<void> {
  try {
    const report = await copyArtifact(
      source,
      destination,
      sourceRepository,
      destinationRepository,
      reference,
    );
    totals.manifests += report.manifests;
    totals.blobs += report.blobs;

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
    await store.recordExecution({
      ruleId: rule.id,
      project: rule.project,
      status: "failed",
      repository: sourceRepository,
      reference,
      manifests: 0,
      blobs: 0,
      error: error instanceof Error ? error.message : String(error),
    });
  }
}

/** Sends this project's matching artifacts to the far registry. */
async function runPush(env: Env, store: ReplicationStore, rule: ReplicationRule, payload: ReplicatePayload) {
  const local = localRegistry(env);
  const remote = await remoteRegistry(store, rule);
  const totals: Totals = { manifests: 0, blobs: 0 };

  // One artifact, named by the push that triggered this.
  if (payload.repository !== undefined && payload.reference !== undefined) {
    if (!ruleMatchesRepository(rule, payload.repository) || !ruleMatchesTag(rule, payload.reference)) {
      return totals;
    }
    await copyOne(
      store,
      rule,
      local,
      remote,
      payload.repository,
      remap(payload.repository, rule.destinationNamespace),
      payload.reference,
      totals,
    );
    return totals;
  }

  const repositories = await env.DB.prepare("SELECT name FROM repositories WHERE project = ?")
    .bind(rule.project)
    .all<{ name: string }>();

  let copied = 0;
  for (const { name } of repositories.results) {
    if (!ruleMatchesRepository(rule, name)) continue;

    for (const tag of await local.listTags(name)) {
      if (copied >= MAX_ARTIFACTS_PER_RUN) return totals;
      if (!ruleMatchesTag(rule, tag)) continue;

      await copyOne(store, rule, local, remote, name, remap(name, rule.destinationNamespace), tag, totals);
      copied++;
    }
  }
  return totals;
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
  const totals: Totals = { manifests: 0, blobs: 0 };

  let copied = 0;
  for (const sourceRepository of rule.sourceRepositories) {
    const destination = destinationFor(rule, sourceRepository);
    if (destination === null) continue;

    let tags: string[];
    try {
      tags = await remote.listTags(sourceRepository);
    } catch (error) {
      await store.recordExecution({
        ruleId: rule.id,
        project: rule.project,
        status: "failed",
        repository: sourceRepository,
        reference: null,
        manifests: 0,
        blobs: 0,
        error: error instanceof Error ? error.message : String(error),
      });
      continue;
    }

    for (const tag of tags) {
      if (copied >= MAX_ARTIFACTS_PER_RUN) return totals;
      if (!ruleMatchesTag(rule, tag)) continue;

      await copyOne(store, rule, remote, local, sourceRepository, destination, tag, totals);
      copied++;
    }
  }
  return totals;
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

  const totals =
    rule.direction === "push" ? await runPush(env, store, rule, input) : await runPull(env, store, rule);
  await store.recordResult(rule, JSON.stringify(totals));
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
