import { type EventType, type NotificationPolicy, isEventType } from "@registry/notifications";
import { flag, jsonArray } from "../storage/codec.js";

interface PolicyRow {
  id: string;
  project: string;
  name: string;
  enabled: number;
  target_type: "webhook" | "email";
  target: string;
  secret: string | null;
  event_types: string;
}

function toPolicy(row: PolicyRow): NotificationPolicy {
  return {
    id: row.id,
    project: row.project,
    name: row.name,
    enabled: flag(row.enabled),
    targetType: row.target_type,
    target: row.target,
    eventTypes: jsonArray(
      row.event_types,
      (value): value is EventType => typeof value === "string" && isEventType(value),
    ),
  };
}

/** A policy plus the secret that signs its deliveries. Never leaves the Worker. */
export interface PolicyWithSecret {
  readonly policy: NotificationPolicy;
  readonly secret: string | null;
}

export class NotificationStore {
  constructor(private readonly db: D1Database) {}

  /** The enabled policies of one project, as the fan-out needs them. */
  async listeners(project: string): Promise<PolicyWithSecret[]> {
    const rows = await this.db
      .prepare(
        `SELECT id, project, name, enabled, target_type, target, secret, event_types
         FROM notification_policies WHERE project = ? AND enabled = 1`,
      )
      .bind(project)
      .all<PolicyRow>();
    return rows.results.map((row) => ({ policy: toPolicy(row), secret: row.secret }));
  }

  async get(id: string): Promise<PolicyWithSecret | null> {
    const row = await this.db
      .prepare(
        `SELECT id, project, name, enabled, target_type, target, secret, event_types
         FROM notification_policies WHERE id = ?`,
      )
      .bind(id)
      .first<PolicyRow>();
    return row === null ? null : { policy: toPolicy(row), secret: row.secret };
  }

  /** The dashboard's view: never the secret. */
  async list(project: string): Promise<NotificationPolicy[]> {
    const rows = await this.db
      .prepare(
        `SELECT id, project, name, enabled, target_type, target, NULL AS secret, event_types
         FROM notification_policies WHERE project = ? ORDER BY name`,
      )
      .bind(project)
      .all<PolicyRow>();
    return rows.results.map(toPolicy);
  }

  async create(input: {
    id: string;
    project: string;
    name: string;
    targetType: "webhook" | "email";
    target: string;
    secret: string | null;
    eventTypes: readonly EventType[];
  }): Promise<NotificationPolicy> {
    const now = Date.now();
    await this.db
      .prepare(
        `INSERT INTO notification_policies
           (id, project, name, enabled, target_type, target, secret, event_types, created_at, updated_at)
         VALUES (?, ?, ?, 1, ?, ?, ?, ?, ?, ?)`,
      )
      .bind(
        input.id,
        input.project,
        input.name,
        input.targetType,
        input.target,
        input.secret,
        JSON.stringify(input.eventTypes),
        now,
        now,
      )
      .run();

    return {
      id: input.id,
      project: input.project,
      name: input.name,
      enabled: true,
      targetType: input.targetType,
      target: input.target,
      eventTypes: input.eventTypes,
    };
  }

  async remove(project: string, id: string): Promise<boolean> {
    const result = await this.db
      .prepare("DELETE FROM notification_policies WHERE id = ? AND project = ?")
      .bind(id, project)
      .run();
    return (result.meta.changes ?? 0) > 0;
  }

  async recordDelivery(input: {
    policyId: string;
    project: string;
    eventType: string;
    status: "delivered" | "failed";
    responseStatus: number | null;
    error: string | null;
  }): Promise<void> {
    await this.db
      .prepare(
        `INSERT INTO notification_deliveries
           (id, policy_id, project, event_type, status, response_status, error, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .bind(
        crypto.randomUUID(),
        input.policyId,
        input.project,
        input.eventType,
        input.status,
        input.responseStatus,
        input.error === null ? null : input.error.slice(0, 500),
        Date.now(),
      )
      .run();
  }

  async deliveries(
    project: string,
    limit: number,
  ): Promise<
    Array<{
      id: string;
      policyId: string;
      eventType: string;
      status: "delivered" | "failed";
      responseStatus: number | null;
      error: string | null;
      createdAt: number;
    }>
  > {
    const rows = await this.db
      .prepare(
        `SELECT id, policy_id, event_type, status, response_status, error, created_at
         FROM notification_deliveries WHERE project = ? ORDER BY created_at DESC LIMIT ?`,
      )
      .bind(project, limit)
      .all<{
        id: string;
        policy_id: string;
        event_type: string;
        // Narrower than the column, which `recordDelivery` is the only writer of.
        status: "delivered" | "failed";
        response_status: number | null;
        error: string | null;
        created_at: number;
      }>();

    return rows.results.map((row) => ({
      id: row.id,
      policyId: row.policy_id,
      eventType: row.event_type,
      status: row.status,
      responseStatus: row.response_status,
      error: row.error,
      createdAt: row.created_at,
    }));
  }
}
