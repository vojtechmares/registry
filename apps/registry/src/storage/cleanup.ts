import type { CleanupPolicy, CleanupRule } from "@registry/api-contract";
import { nextRun } from "@registry/cron";
import { flag, flagValue, jsonColumn } from "./codec.js";

interface PolicyRow {
  project: string;
  enabled: number;
  schedule: string;
  rules: string;
  untagged_older_than_days: number | null;
  next_run_at: number | null;
  last_run_at: number | null;
  last_result: string | null;
}

function toPolicy(row: PolicyRow): CleanupPolicy {
  return {
    project: row.project,
    enabled: flag(row.enabled),
    schedule: row.schedule,
    rules: jsonColumn<CleanupRule[]>(row.rules, []),
    untaggedOlderThanDays: row.untagged_older_than_days,
    nextRunAt: row.next_run_at,
    lastRunAt: row.last_run_at,
    lastResult: jsonColumn<CleanupPolicy["lastResult"]>(row.last_result, null),
  };
}

export interface CleanupPolicyInput {
  readonly enabled: boolean;
  readonly schedule: string;
  readonly rules: readonly CleanupRule[];
  readonly untaggedOlderThanDays: number | null;
}

export class CleanupStore {
  constructor(private readonly db: D1Database) {}

  async get(project: string): Promise<CleanupPolicy | null> {
    const row = await this.db
      .prepare(
        `SELECT project, enabled, schedule, rules, untagged_older_than_days,
                next_run_at, last_run_at, last_result
         FROM cleanup_policies WHERE project = ?`,
      )
      .bind(project)
      .first<PolicyRow>();
    return row === null ? null : toPolicy(row);
  }

  /**
   * Stores the policy and computes when it next fires, so the cron trigger only
   * ever asks "what is due?" and never has to parse an expression to find out.
   *
   * A disabled policy has no next run. Neither does one whose expression names
   * a date that never comes, which `nextRun` reports as null rather than
   * looping until it finds the 30th of February.
   */
  async put(project: string, input: CleanupPolicyInput, now = Date.now()): Promise<CleanupPolicy> {
    const next = input.enabled ? nextRun(input.schedule, now) : null;

    await this.db
      .prepare(
        `INSERT INTO cleanup_policies
           (project, enabled, schedule, rules, untagged_older_than_days, next_run_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT (project) DO UPDATE SET
           enabled = excluded.enabled,
           schedule = excluded.schedule,
           rules = excluded.rules,
           untagged_older_than_days = excluded.untagged_older_than_days,
           next_run_at = excluded.next_run_at,
           updated_at = excluded.updated_at`,
      )
      .bind(
        project,
        flagValue(input.enabled),
        input.schedule,
        JSON.stringify(input.rules),
        input.untaggedOlderThanDays,
        next,
        now,
      )
      .run();

    return (await this.get(project))!;
  }

  async remove(project: string): Promise<boolean> {
    const result = await this.db
      .prepare("DELETE FROM cleanup_policies WHERE project = ?")
      .bind(project)
      .run();
    return (result.meta.changes ?? 0) > 0;
  }

  /** The project's recent retirements, most recent first. */
  async events(
    project: string,
    limit: number,
  ): Promise<
    Array<{ repository: string | null; action: string; subject: string; reason: string; createdAt: number }>
  > {
    const rows = await this.db
      .prepare(
        `SELECT repository, action, subject, reason, created_at
         FROM lifecycle_events WHERE project = ? ORDER BY created_at DESC LIMIT ?`,
      )
      .bind(project, limit)
      .all<{
        repository: string | null;
        action: string;
        subject: string;
        reason: string;
        created_at: number;
      }>();

    return rows.results.map((row) => ({
      repository: row.repository,
      action: row.action,
      subject: row.subject,
      reason: row.reason,
      createdAt: row.created_at,
    }));
  }
}
