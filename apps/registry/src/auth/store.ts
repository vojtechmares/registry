import type { Action } from "@registry/registry-core";
import { parseScopes, type Scope } from "./scopes.js";

export interface UserRecord {
  readonly id: string;
  readonly username: string;
  readonly passwordHash: string;
  readonly isAdmin: boolean;
  readonly disabled: boolean;
}

export interface AccessTokenRecord {
  readonly id: string;
  readonly userId: string;
  readonly secretHash: string;
  readonly scopes: Scope[];
  readonly expiresAt: number | null;
  readonly revoked: boolean;
}

export class AuthStore {
  constructor(private readonly db: D1Database) {}

  async findUserByUsername(username: string): Promise<UserRecord | null> {
    const row = await this.db
      .prepare("SELECT id, username, password_hash, is_admin, disabled FROM users WHERE username = ?")
      .bind(username)
      .first<{ id: string; username: string; password_hash: string; is_admin: number; disabled: number }>();
    if (row === null) return null;
    return {
      id: row.id,
      username: row.username,
      passwordHash: row.password_hash,
      isAdmin: row.is_admin === 1,
      disabled: row.disabled === 1,
    };
  }

  async findUserById(id: string): Promise<UserRecord | null> {
    const row = await this.db
      .prepare("SELECT id, username, password_hash, is_admin, disabled FROM users WHERE id = ?")
      .bind(id)
      .first<{ id: string; username: string; password_hash: string; is_admin: number; disabled: number }>();
    if (row === null) return null;
    return {
      id: row.id,
      username: row.username,
      passwordHash: row.password_hash,
      isAdmin: row.is_admin === 1,
      disabled: row.disabled === 1,
    };
  }

  async findAccessToken(id: string): Promise<AccessTokenRecord | null> {
    const row = await this.db
      .prepare("SELECT id, user_id, secret_hash, scopes, expires_at, revoked FROM access_tokens WHERE id = ?")
      .bind(id)
      .first<{
        id: string;
        user_id: string;
        secret_hash: string;
        scopes: string;
        expires_at: number | null;
        revoked: number;
      }>();
    if (row === null) return null;
    return {
      id: row.id,
      userId: row.user_id,
      secretHash: row.secret_hash,
      scopes: parseScopes(row.scopes),
      expiresAt: row.expires_at,
      revoked: row.revoked === 1,
    };
  }

  async touchAccessToken(id: string): Promise<void> {
    await this.db
      .prepare("UPDATE access_tokens SET last_used_at = ? WHERE id = ?")
      .bind(Date.now(), id)
      .run();
  }

  /** Explicit grants for a user, which admins bypass and owners do not need. */
  async grantsFor(userId: string, repository: string): Promise<Action[]> {
    const row = await this.db
      .prepare("SELECT actions FROM repository_grants WHERE user_id = ? AND repository = ?")
      .bind(userId, repository)
      .first<{ actions: string }>();
    if (row === null) return [];
    return row.actions
      .split(",")
      .filter((action): action is Action => action === "pull" || action === "push" || action === "delete");
  }

  async repositoryVisibility(repository: string): Promise<"public" | "private" | null> {
    const row = await this.db
      .prepare("SELECT visibility FROM repositories WHERE name = ?")
      .bind(repository)
      .first<{ visibility: "public" | "private" }>();
    return row?.visibility ?? null;
  }
}
