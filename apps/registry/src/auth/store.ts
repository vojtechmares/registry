import { type Role, type Visibility, isRole, projectOf } from "@registry/projects";
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
  /** Non-null pins the token to one project. */
  readonly project: string | null;
  readonly expiresAt: number | null;
  readonly revoked: boolean;
}

/** A project as an access decision needs to see it: how visible, and the caller's role in it. */
export interface ProjectAccessRecord {
  readonly name: string;
  readonly visibility: Visibility;
  readonly role: Role | null;
}

const USER_COLUMNS = "id, username, password_hash, is_admin, disabled";

interface UserRow {
  id: string;
  username: string;
  password_hash: string;
  is_admin: number;
  disabled: number;
}

function toUser(row: UserRow): UserRecord {
  return {
    id: row.id,
    username: row.username,
    passwordHash: row.password_hash,
    isAdmin: row.is_admin === 1,
    disabled: row.disabled === 1,
  };
}

export class AuthStore {
  constructor(private readonly db: D1Database) {}

  async findUserByUsername(username: string): Promise<UserRecord | null> {
    const row = await this.db
      .prepare(`SELECT ${USER_COLUMNS} FROM users WHERE username = ?`)
      .bind(username)
      .first<UserRow>();
    return row === null ? null : toUser(row);
  }

  async findUserById(id: string): Promise<UserRecord | null> {
    const row = await this.db
      .prepare(`SELECT ${USER_COLUMNS} FROM users WHERE id = ?`)
      .bind(id)
      .first<UserRow>();
    return row === null ? null : toUser(row);
  }

  async findAccessToken(id: string): Promise<AccessTokenRecord | null> {
    const row = await this.db
      .prepare(
        `SELECT id, user_id, secret_hash, scopes, project, expires_at, revoked
         FROM access_tokens WHERE id = ?`,
      )
      .bind(id)
      .first<{
        id: string;
        user_id: string;
        secret_hash: string;
        scopes: string;
        project: string | null;
        expires_at: number | null;
        revoked: number;
      }>();
    if (row === null) return null;
    return {
      id: row.id,
      userId: row.user_id,
      secretHash: row.secret_hash,
      scopes: parseScopes(row.scopes),
      project: row.project,
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

  /**
   * The project a repository belongs to, together with the caller's role in it.
   *
   * One round trip, because this sits on the critical path of every registry
   * request. Null means the project does not exist - which a push by an
   * administrator, or by the user it is named after, may still turn into a
   * creation.
   */
  async projectAccess(repository: string, userId: string | null): Promise<ProjectAccessRecord | null> {
    const row = await this.db
      .prepare(
        `SELECT p.name, p.visibility, m.role
         FROM projects AS p
         LEFT JOIN project_members AS m ON m.project = p.name AND m.user_id = ?
         WHERE p.name = ?`,
      )
      .bind(userId, projectOf(repository))
      .first<{ name: string; visibility: Visibility; role: string | null }>();
    if (row === null) return null;

    return {
      name: row.name,
      visibility: row.visibility,
      role: row.role !== null && isRole(row.role) ? row.role : null,
    };
  }
}
