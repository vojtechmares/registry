/**
 * The durable work queue, against real D1.
 *
 * The properties that matter are the ones a queue is for: a task is claimed
 * exactly once, a task whose Worker died is claimed again, a failure retries
 * with backoff until it does not, and nothing is ever lost.
 */

import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { BASE_DELAY_MS, MAX_DELAY_MS, backoffDelay } from "../src/tasks/backoff.js";
import { TaskQueue } from "../src/tasks/queue.js";
import { runTask, sweepTasks } from "../src/tasks/runner.js";

const NOW = Date.parse("2026-07-10T00:00:00Z");

async function statusOf(id: string): Promise<{ status: string; attempts: number; run_after: number }> {
  const row = await env.DB.prepare("SELECT status, attempts, run_after FROM tasks WHERE id = ?")
    .bind(id)
    .first<{ status: string; attempts: number; run_after: number }>();
  return row!;
}

/** A jitter source that always picks the top of the window, so the schedule is exact. */
const noJitter = () => 1;

describe("backoffDelay", () => {
  it("doubles with each attempt", () => {
    expect(backoffDelay(1, noJitter)).toBe(BASE_DELAY_MS);
    expect(backoffDelay(2, noJitter)).toBe(BASE_DELAY_MS * 2);
    expect(backoffDelay(3, noJitter)).toBe(BASE_DELAY_MS * 4);
  });

  it("is capped", () => {
    expect(backoffDelay(100, noJitter)).toBe(MAX_DELAY_MS);
    expect(backoffDelay(1000, noJitter)).toBe(MAX_DELAY_MS);
  });

  it("spreads over half the window, so a recovered endpoint is not stampeded", () => {
    expect(backoffDelay(1, () => 0)).toBe(BASE_DELAY_MS / 2);
    expect(backoffDelay(1, noJitter)).toBe(BASE_DELAY_MS);
  });

  it("never goes backwards for a first attempt", () => {
    expect(backoffDelay(0, () => 0)).toBeGreaterThan(0);
  });
});

describe("claiming", () => {
  it("claims a due task exactly once", async () => {
    const queue = new TaskQueue(env.DB);
    await queue.enqueue({ kind: "test", payload: { a: 1 } }, NOW);

    const first = await queue.claim(10, NOW);
    expect(first).toHaveLength(1);
    expect(first[0]?.payload).toEqual({ a: 1 });

    // Already running under a live lease.
    expect(await queue.claim(10, NOW)).toHaveLength(0);
  });

  it("does not claim a task scheduled for the future", async () => {
    const queue = new TaskQueue(env.DB);
    await queue.enqueue({ kind: "test", payload: {}, runAfter: NOW + 60_000 }, NOW);
    expect(await queue.claim(10, NOW)).toHaveLength(0);
    expect(await queue.claim(10, NOW + 60_000)).toHaveLength(1);
  });

  it("reclaims a task whose lease expired, which is how a dead Worker's work survives", async () => {
    const queue = new TaskQueue(env.DB);
    await queue.enqueue({ kind: "test", payload: {} }, NOW);
    await queue.claim(10, NOW);

    // Five minutes later the lease is gone and nobody completed it.
    const reclaimed = await queue.claim(10, NOW + 6 * 60 * 1000);
    expect(reclaimed).toHaveLength(1);
    expect(reclaimed[0]?.attempts).toBe(2);
  });

  it("counts an attempt on every claim", async () => {
    const queue = new TaskQueue(env.DB);
    const id = await queue.enqueue({ kind: "test", payload: {} }, NOW);
    const [task] = await queue.claim(10, NOW);
    expect(task?.attempts).toBe(1);
    expect((await statusOf(id)).status).toBe("running");
  });

  it("claims one task by id, for the run that follows an enqueue", async () => {
    const queue = new TaskQueue(env.DB);
    const id = await queue.enqueue({ kind: "test", payload: { x: 1 } }, NOW);

    const claimed = await queue.claimOne(id, NOW);
    expect(claimed?.payload).toEqual({ x: 1 });
    // Not twice.
    expect(await queue.claimOne(id, NOW)).toBeNull();
  });
});

describe("completing and failing", () => {
  it("marks a completed task done", async () => {
    const queue = new TaskQueue(env.DB);
    const id = await queue.enqueue({ kind: "test", payload: {} }, NOW);
    const [task] = await queue.claim(10, NOW);
    await queue.complete(task!.id, NOW);
    expect((await statusOf(id)).status).toBe("done");
  });

  it("schedules a retry while attempts remain", async () => {
    const queue = new TaskQueue(env.DB);
    const id = await queue.enqueue({ kind: "test", payload: {}, maxAttempts: 3 }, NOW);
    const [task] = await queue.claim(10, NOW);

    await queue.fail(task!, new Error("boom"), NOW);
    const after = await statusOf(id);
    expect(after.status).toBe("pending");
    expect(after.run_after).toBeGreaterThan(NOW);
  });

  it("gives up once the attempts are exhausted", async () => {
    const queue = new TaskQueue(env.DB);
    const id = await queue.enqueue({ kind: "test", payload: {}, maxAttempts: 1 }, NOW);
    const [task] = await queue.claim(10, NOW);

    await queue.fail(task!, new Error("boom"), NOW);
    expect((await statusOf(id)).status).toBe("failed");

    // And is never claimed again.
    expect(await queue.claim(10, NOW + 86_400_000)).toHaveLength(0);
  });

  it("records the error, truncated", async () => {
    const queue = new TaskQueue(env.DB);
    const id = await queue.enqueue({ kind: "test", payload: {}, maxAttempts: 1 }, NOW);
    const [task] = await queue.claim(10, NOW);
    await queue.fail(task!, new Error("x".repeat(5000)), NOW);

    const row = await env.DB.prepare("SELECT last_error FROM tasks WHERE id = ?")
      .bind(id)
      .first<{ last_error: string }>();
    expect(row?.last_error.length).toBe(1000);
  });
});

describe("running", () => {
  it("runs a handler and completes the task", async () => {
    const queue = new TaskQueue(env.DB);
    const id = await queue.enqueue({ kind: "greet", payload: { name: "world" } }, NOW);
    const [task] = await queue.claim(10, NOW);

    const seen: unknown[] = [];
    const ok = await runTask(queue, { greet: async (payload) => void seen.push(payload) }, task!, env);

    expect(ok).toBe(true);
    expect(seen).toEqual([{ name: "world" }]);
    expect((await statusOf(id)).status).toBe("done");
  });

  it("retries a handler that throws", async () => {
    const queue = new TaskQueue(env.DB);
    const id = await queue.enqueue({ kind: "boom", payload: {}, maxAttempts: 5 }, NOW);
    const [task] = await queue.claim(10, NOW);

    const ok = await runTask(
      queue,
      {
        boom: async () => {
          throw new Error("nope");
        },
      },
      task!,
      env,
    );

    expect(ok).toBe(false);
    expect((await statusOf(id)).status).toBe("pending");
  });

  it("fails an unknown kind permanently, since the next attempt cannot differ", async () => {
    const queue = new TaskQueue(env.DB);
    const id = await queue.enqueue({ kind: "mystery", payload: {}, maxAttempts: 9 }, NOW);
    const [task] = await queue.claim(10, NOW);

    await runTask(queue, {}, task!, env);
    expect((await statusOf(id)).status).toBe("failed");
  });

  it("drains the queue in a sweep", async () => {
    const queue = new TaskQueue(env.DB);
    await queue.enqueue({ kind: "noop", payload: {} }, NOW);
    await queue.enqueue({ kind: "noop", payload: {} }, NOW);
    await queue.enqueue({ kind: "noop", payload: {} }, NOW);

    const result = await sweepTasks(env, { noop: async () => {} }, NOW);
    expect(result).toEqual({ ran: 3, succeeded: 3 });
    expect(await queue.claim(10, NOW)).toHaveLength(0);
  });
});

describe("pruning", () => {
  it("drops finished tasks and keeps live ones", async () => {
    const queue = new TaskQueue(env.DB);
    const done = await queue.enqueue({ kind: "noop", payload: {} }, NOW);
    const pending = await queue.enqueue({ kind: "noop", payload: {} }, NOW);
    await queue.complete(done, NOW);

    const removed = await queue.prune(1000, NOW + 5000);
    expect(removed).toBe(1);
    expect(await statusOf(pending)).toBeTruthy();
  });
});
