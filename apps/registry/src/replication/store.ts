import { nextRun } from "@registry/cron";
import type { Direction, ReplicationRule, Trigger } from "@registry/replication";
import type { TagFilter } from "@registry/semver";
import { seal, unseal } from "../crypto/sealed.js";
import { flag, jsonColumn } from "../storage/codec.js";

interface RuleRow {
  id: string;
  project: string;
  name: string;
  enabled: number;
  direction: Direction;
  remote_url: string;
  remote_username: string | null;
  remote_password: string | null;
  destination_namespace: string;
  repository_filter: string;
  source_repositories: string;
  tag_filter: string;
  trigger: Trigger;
  schedule: string | null;
  next_run_at: number | null;
  last_run_at: number | null;
  last_result: string | null;
}

const COLUMNS = `id, project, name, enabled, direction, remote_url, remote_username, remote_password,
                 destination_namespace, repository_filter, source_repositories, tag_filter,
                 trigger, schedule, next_run_at, last_run_at, last_result`;

function toRule(row: RuleRow): ReplicationRule {
  return {
    id: row.id,
    project: row.project,
    name: row.name,
    enabled: flag(row.enabled),
    direction: row.direction,
    remoteUrl: row.remote_url,
    destinationNamespace: row.destination_namespace,
    repositoryFilter: row.repository_filter,
    sourceRepositories: jsonColumn<string[]>(row.source_repositories, []),
    tagFilter: jsonColumn<TagFilter>(row.tag_filter, {}),
    trigger: row.trigger,
    schedule: row.schedule,
  };
}

/** A rule as the dashboard sees it: the schedule's state, never the password. */
export interface ReplicationRuleView extends ReplicationRule {
  readonly remoteUsername: string | null;
  readonly nextRunAt: number | null;
  readonly lastRunAt: number | null;
  readonly lastResult: string | null;
}

function toView(row: RuleRow): ReplicationRuleView {
  return {
    ...toRule(row),
    remoteUsername: row.remote_username,
    nextRunAt: row.next_run_at,
    lastRunAt: row.last_run_at,
    lastResult: row.last_result,
  };
}

export interface RemoteCredentials {
  readonly username: string;
  readonly password: string;
}

export interface CreateRuleInput {
  readonly id: string;
  readonly project: string;
  readonly name: string;
  readonly direction: Direction;
  readonly remoteUrl: string;
  readonly credentials: RemoteCredentials | null;
  readonly destinationNamespace: string;
  readonly repositoryFilter: string;
  readonly sourceRepositories: readonly string[];
  readonly tagFilter: TagFilter;
  readonly trigger: Trigger;
  readonly schedule: string | null;
}

export class ReplicationStore {
  constructor(
    private readonly db: D1Database,
    /** Keys the credential sealing. The Worker's signing secret, by default. */
    private readonly secret: string,
  ) {}

  async list(project: string): Promise<ReplicationRuleView[]> {
    const rows = await this.db
      .prepare(`SELECT ${COLUMNS} FROM replication_rules WHERE project = ? ORDER BY name`)
      .bind(project)
      .all<RuleRow>();
    return rows.results.map(toView);
  }

  /** The rules a manifest push may set off, before any of them is asked whether it matches. */
  async eventRules(project: string): Promise<ReplicationRule[]> {
    const rows = await this.db
      .prepare(
        `SELECT ${COLUMNS} FROM replication_rules
         WHERE project = ? AND enabled = 1 AND direction = 'push' AND trigger = 'event'`,
      )
      .bind(project)
      .all<RuleRow>();
    return rows.results.map(toRule);
  }

  async get(id: string): Promise<ReplicationRule | null> {
    const row = await this.db
      .prepare(`SELECT ${COLUMNS} FROM replication_rules WHERE id = ?`)
      .bind(id)
      .first<RuleRow>();
    return row === null ? null : toRule(row);
  }

  /** Decrypts the rule's credentials. Null when it has none, or when the seal will not open. */
  async credentials(id: string): Promise<RemoteCredentials | null> {
    const row = await this.db
      .prepare("SELECT remote_username, remote_password FROM replication_rules WHERE id = ?")
      .bind(id)
      .first<{ remote_username: string | null; remote_password: string | null }>();

    if (row?.remote_username == null || row.remote_password === null) return null;

    const password = await unseal(row.remote_password, this.secret);
    if (password === null) {
      console.error("replication credentials could not be decrypted", { rule: id });
      return null;
    }
    return { username: row.remote_username, password };
  }

  async create(input: CreateRuleInput, now = Date.now()): Promise<ReplicationRuleView> {
    const sealed = input.credentials === null ? null : await seal(input.credentials.password, this.secret);
    const next =
      input.trigger === "scheduled" && input.schedule !== null ? nextRun(input.schedule, now) : null;

    await this.db
      .prepare(
        `INSERT INTO replication_rules
           (id, project, name, enabled, direction, remote_url, remote_username, remote_password,
            destination_namespace, repository_filter, source_repositories, tag_filter,
            trigger, schedule, next_run_at, created_at, updated_at)
         VALUES (?, ?, ?, 1, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .bind(
        input.id,
        input.project,
        input.name,
        input.direction,
        input.remoteUrl,
        input.credentials?.username ?? null,
        sealed,
        input.destinationNamespace,
        input.repositoryFilter,
        JSON.stringify(input.sourceRepositories),
        JSON.stringify(input.tagFilter),
        input.trigger,
        input.schedule,
        next,
        now,
        now,
      )
      .run();

    const row = await this.db
      .prepare(`SELECT ${COLUMNS} FROM replication_rules WHERE id = ?`)
      .bind(input.id)
      .first<RuleRow>();
    return toView(row!);
  }

  async remove(project: string, id: string): Promise<boolean> {
    const result = await this.db
      .prepare("DELETE FROM replication_rules WHERE id = ? AND project = ?")
      .bind(id, project)
      .run();
    return (result.meta.changes ?? 0) > 0;
  }

  /** Rules whose cron expression has come due. */
  async due(now: number, limit: number): Promise<ReplicationRule[]> {
    const rows = await this.db
      .prepare(
        `SELECT ${COLUMNS} FROM replication_rules
         WHERE enabled = 1 AND trigger = 'scheduled' AND next_run_at IS NOT NULL AND next_run_at <= ?
         ORDER BY next_run_at ASC LIMIT ?`,
      )
      .bind(now, limit)
      .all<RuleRow>();
    return rows.results.map(toRule);
  }

  /**
   * Advances the schedule. Called before a run rather than after it, so a rule
   * that fails does not immediately run again and starve the others.
   */
  async reschedule(rule: ReplicationRule, now: number): Promise<void> {
    const next = rule.schedule === null ? null : nextRun(rule.schedule, now);
    await this.db
      .prepare("UPDATE replication_rules SET next_run_at = ?, last_run_at = ? WHERE id = ?")
      .bind(next, now, rule.id)
      .run();
  }

  async recordResult(rule: ReplicationRule, summary: string, now = Date.now()): Promise<void> {
    await this.db
      .prepare("UPDATE replication_rules SET last_result = ?, last_run_at = ? WHERE id = ?")
      .bind(summary.slice(0, 500), now, rule.id)
      .run();
  }

  async recordExecution(input: {
    ruleId: string;
    project: string;
    status: "succeeded" | "failed";
    repository: string | null;
    reference: string | null;
    manifests: number;
    blobs: number;
    error: string | null;
  }): Promise<void> {
    await this.db
      .prepare(
        `INSERT INTO replication_executions
           (id, rule_id, project, status, repository, reference, manifests, blobs, error, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .bind(
        crypto.randomUUID(),
        input.ruleId,
        input.project,
        input.status,
        input.repository,
        input.reference,
        input.manifests,
        input.blobs,
        input.error === null ? null : input.error.slice(0, 500),
        Date.now(),
      )
      .run();
  }

  async executions(project: string, limit: number) {
    const rows = await this.db
      .prepare(
        `SELECT id, rule_id, status, repository, reference, manifests, blobs, error, created_at
         FROM replication_executions WHERE project = ? ORDER BY created_at DESC LIMIT ?`,
      )
      .bind(project, limit)
      .all<{
        id: string;
        rule_id: string;
        // Narrower than the column, which `recordExecution` is the only writer of.
        status: "succeeded" | "failed";
        repository: string | null;
        reference: string | null;
        manifests: number;
        blobs: number;
        error: string | null;
        created_at: number;
      }>();

    return rows.results.map((row) => ({
      id: row.id,
      ruleId: row.rule_id,
      status: row.status,
      repository: row.repository,
      reference: row.reference,
      manifests: row.manifests,
      blobs: row.blobs,
      error: row.error,
      createdAt: row.created_at,
    }));
  }
}
