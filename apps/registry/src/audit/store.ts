import type { AuditActorKind, AuditEvent, AuditPage, AuditResourceType } from "@registry/api-contract";
import type { Principal } from "../auth/principal.js";
import { jsonObject } from "../storage/codec.js";

/** Who is making a change. `system` is a cron, which has no principal at all. */
export interface AuditActor {
  readonly id: string | null;
  readonly name: string;
  readonly kind: AuditActorKind;
  readonly tokenId: string | null;
}

export const SYSTEM_ACTOR: AuditActor = { id: null, name: "system", kind: "system", tokenId: null };

export function actorOf(principal: Principal): AuditActor {
  if (principal.kind === "anonymous") {
    return { id: null, name: "anonymous", kind: "anonymous", tokenId: null };
  }
  const { id, username } = principal.identity;
  return {
    id,
    name: username,
    kind: principal.kind,
    // The owner and the credential are different answers to different questions,
    // and revoking a token answers only the second.
    tokenId: principal.kind === "token" ? principal.tokenId : null,
  };
}

export interface AuditEntry {
  readonly actor: AuditActor;
  readonly action: string;
  readonly resourceType: AuditResourceType;
  readonly resource: string;
  readonly project?: string | null;
  readonly detail?: Record<string, unknown> | null;
}

export interface AuditQuery {
  readonly resourceType?: AuditResourceType | undefined;
  readonly project?: string | undefined;
  readonly actor?: string | undefined;
  readonly action?: string | undefined;
  readonly limit: number;
  readonly cursor?: string | undefined;
}

interface Row {
  id: string;
  actor_id: string | null;
  actor_name: string;
  actor_kind: AuditActorKind;
  actor_token_id: string | null;
  action: string;
  resource_type: AuditResourceType;
  resource: string;
  project: string | null;
  detail: string | null;
  created_at: number;
}

/**
 * A cursor is `<created_at>:<id>`, which is the sort key.
 *
 * Not an offset: a page read while rows are being written would skip whichever
 * row the new one displaced, and an audit log that silently omits a row is
 * worse than one that does not paginate.
 */
function encodeCursor(row: { createdAt: number; id: string }): string {
  return `${row.createdAt}:${row.id}`;
}

function decodeCursor(cursor: string): { createdAt: number; id: string } | null {
  const separator = cursor.indexOf(":");
  if (separator === -1) return null;
  const createdAt = Number(cursor.slice(0, separator));
  const id = cursor.slice(separator + 1);
  if (!Number.isSafeInteger(createdAt) || id === "") return null;
  return { createdAt, id };
}

function toEvent(row: Row): AuditEvent {
  return {
    id: row.id,
    actorId: row.actor_id,
    actorName: row.actor_name,
    actorKind: row.actor_kind,
    actorTokenId: row.actor_token_id,
    action: row.action,
    resourceType: row.resource_type,
    resource: row.resource,
    project: row.project,
    detail: jsonObject<Record<string, unknown>>(row.detail),
    createdAt: row.created_at,
  };
}

export class AuditStore {
  constructor(private readonly db: D1Database) {}

  private statement(entry: AuditEntry, at: number): D1PreparedStatement {
    return this.db
      .prepare(
        `INSERT INTO audit_events
           (id, actor_id, actor_name, actor_kind, actor_token_id,
            action, resource_type, resource, project, detail, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .bind(
        crypto.randomUUID(),
        entry.actor.id,
        entry.actor.name,
        entry.actor.kind,
        entry.actor.tokenId,
        entry.action,
        entry.resourceType,
        entry.resource,
        entry.project ?? null,
        entry.detail === undefined || entry.detail === null ? null : JSON.stringify(entry.detail),
        at,
      );
  }

  /**
   * Records one change.
   *
   * Called after the change has already been made, and so not atomic with it: a
   * Worker that dies in between leaves a change nobody is recorded as making.
   * D1 gives a request no transaction across statements, and the alternative -
   * threading an audit row through every store method so the two share a
   * `batch()` - buys that atomicity at the cost of every store method knowing
   * about auditing.
   */
  async record(entry: AuditEntry, at = Date.now()): Promise<void> {
    await this.statement(entry, at).run();
  }

  /** One round trip for a request that changed several things. */
  async recordMany(entries: readonly AuditEntry[], at = Date.now()): Promise<void> {
    if (entries.length === 0) return;
    await this.db.batch(entries.map((entry) => this.statement(entry, at)));
  }

  async list(query: AuditQuery): Promise<AuditPage> {
    const filters: string[] = [];
    const bindings: unknown[] = [];

    if (query.resourceType !== undefined) {
      filters.push("resource_type = ?");
      bindings.push(query.resourceType);
    }
    if (query.project !== undefined) {
      filters.push("project = ?");
      bindings.push(query.project);
    }
    if (query.actor !== undefined) {
      filters.push("actor_name = ?");
      bindings.push(query.actor);
    }
    if (query.action !== undefined) {
      filters.push("action = ?");
      bindings.push(query.action);
    }

    if (query.cursor !== undefined) {
      const after = decodeCursor(query.cursor);
      // An unreadable cursor reads the first page rather than failing: it can
      // only have come from a hand-edited URL.
      if (after !== null) {
        filters.push("(created_at < ? OR (created_at = ? AND id < ?))");
        bindings.push(after.createdAt, after.createdAt, after.id);
      }
    }

    const where = filters.length === 0 ? "" : `WHERE ${filters.join(" AND ")}`;

    // One more than asked for, to learn whether another page exists without
    // counting the table.
    const rows = await this.db
      .prepare(
        `SELECT id, actor_id, actor_name, actor_kind, actor_token_id,
                action, resource_type, resource, project, detail, created_at
         FROM audit_events
         ${where}
         ORDER BY created_at DESC, id DESC
         LIMIT ?`,
      )
      .bind(...bindings, query.limit + 1)
      .all<Row>();

    const page = rows.results.slice(0, query.limit).map(toEvent);
    const last = page.at(-1);
    const cursor = rows.results.length > query.limit && last !== undefined ? encodeCursor(last) : null;
    return { events: page, cursor };
  }

  /** Drops rows older than the retention window. Returns how many went. */
  async prune(olderThanMs: number, now = Date.now()): Promise<number> {
    const result = await this.db
      .prepare("DELETE FROM audit_events WHERE created_at < ?")
      .bind(now - olderThanMs)
      .run();
    return result.meta.changes ?? 0;
  }
}
