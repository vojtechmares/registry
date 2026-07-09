import { backoffDelay } from "./backoff.js";

export type TaskStatus = "pending" | "running" | "done" | "failed";

export interface Task {
  readonly id: string;
  readonly kind: string;
  readonly payload: unknown;
  readonly attempts: number;
  readonly maxAttempts: number;
}

export interface EnqueueOptions {
  readonly kind: string;
  readonly payload: unknown;
  readonly maxAttempts?: number;
  /** Not before this instant. Defaults to now. */
  readonly runAfter?: number;
}

/** How long a claim holds a task before another sweep may take it. */
const LEASE_MS = 5 * 60 * 1000;

/** Bounds one sweep, which shares a cron invocation's budget with everything else. */
const MAX_CLAIM = 25;

interface TaskRow {
  id: string;
  kind: string;
  payload: string;
  attempts: number;
  max_attempts: number;
}

function parsePayload(raw: string): unknown {
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

/**
 * A durable queue in D1.
 *
 * Claiming is a single `UPDATE ... RETURNING`, which D1 runs atomically, so two
 * concurrent sweeps cannot take the same task. Everything else follows from
 * that: a lease that expires recovers a task whose Worker died, and a failure
 * either schedules a retry or gives up, never both.
 */
export class TaskQueue {
  constructor(private readonly db: D1Database) {}

  async enqueue(options: EnqueueOptions, now = Date.now()): Promise<string> {
    const id = crypto.randomUUID();
    await this.db
      .prepare(
        `INSERT INTO tasks (id, kind, payload, status, attempts, max_attempts, run_after, created_at, updated_at)
         VALUES (?, ?, ?, 'pending', 0, ?, ?, ?, ?)`,
      )
      .bind(
        id,
        options.kind,
        JSON.stringify(options.payload),
        options.maxAttempts ?? 5,
        options.runAfter ?? now,
        now,
        now,
      )
      .run();
    return id;
  }

  /**
   * Takes up to `limit` runnable tasks and marks them running.
   *
   * Runnable means pending and due, or running under a lease that has expired -
   * which is the only way a task survives the Worker that was executing it
   * being torn down mid-flight.
   */
  async claim(limit = MAX_CLAIM, now = Date.now()): Promise<Task[]> {
    const rows = await this.db
      .prepare(
        `UPDATE tasks
            SET status = 'running',
                lease_until = ?1 + ?2,
                attempts = attempts + 1,
                updated_at = ?1
          WHERE id IN (
            SELECT id FROM tasks
             WHERE (status = 'pending' AND run_after <= ?1)
                OR (status = 'running' AND lease_until IS NOT NULL AND lease_until < ?1)
             ORDER BY run_after ASC
             LIMIT ?3
          )
          RETURNING id, kind, payload, attempts, max_attempts`,
      )
      .bind(now, LEASE_MS, Math.min(limit, MAX_CLAIM))
      .all<TaskRow>();

    return rows.results.map((row) => ({
      id: row.id,
      kind: row.kind,
      payload: parsePayload(row.payload),
      attempts: row.attempts,
      maxAttempts: row.max_attempts,
    }));
  }

  /** Claims one specific task, for the immediate run that follows an enqueue. */
  async claimOne(id: string, now = Date.now()): Promise<Task | null> {
    const row = await this.db
      .prepare(
        `UPDATE tasks
            SET status = 'running', lease_until = ?2 + ?3, attempts = attempts + 1, updated_at = ?2
          WHERE id = ?1 AND status = 'pending' AND run_after <= ?2
          RETURNING id, kind, payload, attempts, max_attempts`,
      )
      .bind(id, now, LEASE_MS)
      .first<TaskRow>();
    if (row === null) return null;

    return {
      id: row.id,
      kind: row.kind,
      payload: parsePayload(row.payload),
      attempts: row.attempts,
      maxAttempts: row.max_attempts,
    };
  }

  async complete(id: string, now = Date.now()): Promise<void> {
    await this.db
      .prepare("UPDATE tasks SET status = 'done', lease_until = NULL, updated_at = ? WHERE id = ?")
      .bind(now, id)
      .run();
  }

  /**
   * Records a failure. Schedules a retry while attempts remain, and gives up
   * once they do not - a task that can never succeed must stop consuming the
   * sweep's budget forever.
   */
  async fail(task: Task, error: unknown, now = Date.now()): Promise<void> {
    const message = error instanceof Error ? error.message : String(error);
    const exhausted = task.attempts >= task.maxAttempts;

    if (exhausted) {
      await this.db
        .prepare(
          "UPDATE tasks SET status = 'failed', lease_until = NULL, last_error = ?, updated_at = ? WHERE id = ?",
        )
        .bind(message.slice(0, 1000), now, task.id)
        .run();
      return;
    }

    await this.db
      .prepare(
        `UPDATE tasks
            SET status = 'pending', lease_until = NULL, run_after = ?, last_error = ?, updated_at = ?
          WHERE id = ?`,
      )
      .bind(now + backoffDelay(task.attempts), message.slice(0, 1000), now, task.id)
      .run();
  }

  /** Drops finished tasks. Called by the nightly sweep so the table stays small. */
  async prune(olderThanMs: number, now = Date.now()): Promise<number> {
    const result = await this.db
      .prepare("DELETE FROM tasks WHERE status IN ('done', 'failed') AND updated_at < ?")
      .bind(now - olderThanMs)
      .run();
    return result.meta.changes ?? 0;
  }
}
