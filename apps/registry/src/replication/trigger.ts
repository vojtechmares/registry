import { rulesTriggeredByPush } from "@registry/replication";
import type { Env } from "../env.js";
import type { RegistryEvent } from "../events.js";
import { TaskQueue } from "../tasks/queue.js";
import { REPLICATE_TASK } from "./execute.js";
import { ReplicationStore } from "./store.js";

/**
 * Queues a replication for every push rule that wanted this manifest.
 *
 * Only a tagged push. A manifest pushed by digest alone is half of a workflow -
 * the half before it is signed, or before its index names it - and replicating
 * it would send a downstream registry an artifact nobody has finished making.
 *
 * Returns how many runs were queued.
 */
export async function triggerReplication(env: Env, events: readonly RegistryEvent[]): Promise<number> {
  const pushes = events.filter((event) => event.kind === "manifest.push" && event.tag !== null);
  if (pushes.length === 0) return 0;

  const store = new ReplicationStore(env.DB, env.JWT_SECRET);
  const queue = new TaskQueue(env.DB);

  // A request touches one project in practice, so its rules are fetched once.
  const rulesByProject = new Map<string, Awaited<ReturnType<typeof store.eventRules>>>();
  let queued = 0;

  for (const push of pushes) {
    let rules = rulesByProject.get(push.project);
    if (rules === undefined) {
      rules = await store.eventRules(push.project);
      rulesByProject.set(push.project, rules);
    }

    for (const rule of rulesTriggeredByPush(rules, push.repository, push.tag)) {
      await queue.enqueue({
        kind: REPLICATE_TASK,
        payload: { ruleId: rule.id, repository: push.repository, reference: push.tag },
        // A downstream registry that is down should be tried for a while, but
        // not forever: the next push of the same tag will queue a fresh run.
        maxAttempts: 4,
      });
      queued++;
    }
  }

  return queued;
}
