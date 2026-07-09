import type { Env } from "../env.js";
import { TaskQueue, type Task } from "./queue.js";

export type TaskHandler = (payload: unknown, env: Env) => Promise<void>;

/**
 * Executes one task, and records what happened either way.
 *
 * A handler that throws schedules a retry; one that runs to completion closes
 * the task. An unknown kind is a permanent failure, because nothing about the
 * next attempt will be different.
 */
export async function runTask(
  queue: TaskQueue,
  handlers: Readonly<Record<string, TaskHandler>>,
  task: Task,
  env: Env,
): Promise<boolean> {
  const handler = handlers[task.kind];
  if (handler === undefined) {
    await queue.fail({ ...task, attempts: task.maxAttempts }, `unknown task kind "${task.kind}"`);
    return false;
  }

  try {
    await handler(task.payload, env);
    await queue.complete(task.id);
    return true;
  } catch (error) {
    console.error("task failed", { id: task.id, kind: task.kind, error });
    await queue.fail(task, error);
    return false;
  }
}

/**
 * Enqueues a task and runs it now, without waiting for the next sweep.
 *
 * The row is written first, so the work survives this request even if the
 * isolate is torn down before `waitUntil` finishes. The immediate run is an
 * optimisation on top of a queue that would have got there anyway.
 */
export async function enqueueAndRun(
  env: Env,
  ctx: { waitUntil(promise: Promise<unknown>): void },
  handlers: Readonly<Record<string, TaskHandler>>,
  options: { kind: string; payload: unknown; maxAttempts?: number },
): Promise<string> {
  const queue = new TaskQueue(env.DB);
  const id = await queue.enqueue(options);

  ctx.waitUntil(
    (async () => {
      const claimed = await queue.claimOne(id);
      if (claimed !== null) await runTask(queue, handlers, claimed, env);
    })(),
  );

  return id;
}

/** Drains the queue as far as one cron invocation reasonably can. */
export async function sweepTasks(
  env: Env,
  handlers: Readonly<Record<string, TaskHandler>>,
  now = Date.now(),
): Promise<{ ran: number; succeeded: number }> {
  const queue = new TaskQueue(env.DB);
  const claimed = await queue.claim(undefined, now);

  let succeeded = 0;
  for (const task of claimed) {
    if (await runTask(queue, handlers, task, env)) succeeded++;
  }
  return { ran: claimed.length, succeeded };
}
