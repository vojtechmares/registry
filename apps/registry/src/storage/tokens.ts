import type { AccessTokenSummary, ProjectAccessToken } from "@registry/api-contract";
import { type Scope, parseScopes } from "../auth/scopes.js";
import { flag } from "./codec.js";

/** Access tokens: a user's own, and the ones pinned to a project. */
export class TokenStore {
  constructor(private readonly db: D1Database) {}

  async listTokens(userId: string): Promise<AccessTokenSummary[]> {
    const rows = await this.db
      .prepare(
        `SELECT id, name, scopes, project, expires_at, revoked, created_at, last_used_at
         FROM access_tokens WHERE user_id = ? ORDER BY created_at DESC`,
      )
      .bind(userId)
      .all<{
        id: string;
        name: string;
        scopes: string;
        project: string | null;
        expires_at: number | null;
        revoked: number;
        created_at: number;
        last_used_at: number | null;
      }>();

    return rows.results.map((row) => ({
      id: row.id,
      name: row.name,
      scopes: parseScopes(row.scopes),
      project: row.project,
      expiresAt: row.expires_at,
      createdAt: row.created_at,
      lastUsedAt: row.last_used_at,
      revoked: flag(row.revoked),
    }));
  }

  async createToken(input: {
    id: string;
    name: string;
    userId: string;
    secretHash: string;
    scopes: readonly Scope[];
    project: string | null;
    expiresAt: number | null;
  }): Promise<AccessTokenSummary> {
    const createdAt = Date.now();
    await this.db
      .prepare(
        `INSERT INTO access_tokens
           (id, name, user_id, secret_hash, scopes, project, expires_at, revoked, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, 0, ?)`,
      )
      .bind(
        input.id,
        input.name,
        input.userId,
        input.secretHash,
        JSON.stringify(input.scopes),
        input.project,
        input.expiresAt,
        createdAt,
      )
      .run();

    return {
      id: input.id,
      name: input.name,
      scopes: input.scopes,
      project: input.project,
      expiresAt: input.expiresAt,
      createdAt,
      lastUsedAt: null,
      revoked: false,
    };
  }

  async revokeToken(userId: string, tokenId: string): Promise<boolean> {
    const result = await this.db
      .prepare("DELETE FROM access_tokens WHERE id = ? AND user_id = ?")
      .bind(tokenId, userId)
      .run();
    return (result.meta.changes ?? 0) > 0;
  }

  /** Every token pinned to the project, whoever minted it. For its owners. */
  async listProjectTokens(project: string): Promise<ProjectAccessToken[]> {
    const rows = await this.db
      .prepare(
        `SELECT t.id, t.name, t.scopes, t.project, t.expires_at, t.revoked, t.created_at, t.last_used_at,
                u.username
         FROM access_tokens AS t
         JOIN users AS u ON u.id = t.user_id
         WHERE t.project = ?
         ORDER BY t.created_at DESC`,
      )
      .bind(project)
      .all<{
        id: string;
        name: string;
        scopes: string;
        project: string;
        expires_at: number | null;
        revoked: number;
        created_at: number;
        last_used_at: number | null;
        username: string;
      }>();

    return rows.results.map((row) => ({
      id: row.id,
      name: row.name,
      username: row.username,
      scopes: parseScopes(row.scopes),
      project: row.project,
      expiresAt: row.expires_at,
      createdAt: row.created_at,
      lastUsedAt: row.last_used_at,
      revoked: flag(row.revoked),
    }));
  }

  /**
   * Revokes a token by project rather than by owner, for an owner cleaning up
   * after a member who has left. The `project` predicate is what stops it from
   * being a way to revoke any token in the registry by guessing its id.
   */
  async revokeProjectToken(project: string, tokenId: string): Promise<boolean> {
    const result = await this.db
      .prepare("DELETE FROM access_tokens WHERE id = ? AND project = ?")
      .bind(tokenId, project)
      .run();
    return (result.meta.changes ?? 0) > 0;
  }
}
