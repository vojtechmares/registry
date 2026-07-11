import type { UserSummary } from "@registry/api-contract";
import { type UserRow, flagValue, toUserSummary } from "./codec.js";

/** User accounts: CRUD, federated (OIDC) account linking, and bootstrap provisioning. */
export class UserStore {
  constructor(private readonly db: D1Database) {}

  async listUsers(): Promise<UserSummary[]> {
    const rows = await this.db
      .prepare("SELECT id, username, email, is_admin, disabled, created_at FROM users ORDER BY username")
      .all<UserRow>();

    return rows.results.map(toUserSummary);
  }

  /** The id of the account holding this address, or null. Addresses are stored lowercase. */
  async findUserIdByEmail(email: string): Promise<string | null> {
    const row = await this.db
      .prepare("SELECT id FROM users WHERE email = ?")
      .bind(email)
      .first<{ id: string }>();
    return row?.id ?? null;
  }

  /** Sets or clears a user's address. Null when the user does not exist. */
  async setUserEmail(id: string, email: string | null): Promise<UserSummary | null> {
    const result = await this.db
      .prepare("UPDATE users SET email = ?, updated_at = ? WHERE id = ?")
      .bind(email, Date.now(), id)
      .run();
    if ((result.meta.changes ?? 0) === 0) return null;

    return this.db
      .prepare("SELECT id, username, email, is_admin, disabled, created_at FROM users WHERE id = ?")
      .bind(id)
      .first<UserRow>()
      .then((row) => (row === null ? null : toUserSummary(row)));
  }

  async createUser(input: {
    id: string;
    username: string;
    email: string | null;
    passwordHash: string;
    isAdmin: boolean;
  }): Promise<UserSummary> {
    const now = Date.now();
    await this.db
      .prepare(
        `INSERT INTO users (id, username, email, password_hash, is_admin, disabled, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, 0, ?, ?)`,
      )
      .bind(input.id, input.username, input.email, input.passwordHash, flagValue(input.isAdmin), now, now)
      .run();

    return {
      id: input.id,
      username: input.username,
      email: input.email,
      isAdmin: input.isAdmin,
      disabled: false,
      createdAt: now,
    };
  }

  async deleteUser(id: string): Promise<boolean> {
    const result = await this.db.prepare("DELETE FROM users WHERE id = ?").bind(id).run();
    return (result.meta.changes ?? 0) > 0;
  }

  /**
   * Finds or creates the local account behind a federated identity.
   *
   * Keyed on (issuer, subject): a subject is unique only within its issuer, and
   * keying on the subject alone would let a second provider claim an account by
   * minting a token for the same subject string.
   *
   * A federated account has no password. `password_hash` holds a marker that no
   * PBKDF2 verification can match, so the account cannot also be reached by
   * guessing a password it does not have.
   */
  async findOrCreateOidcUser(input: {
    issuer: string;
    subject: string;
    username: string;
    email: string | null;
    isAdmin: boolean;
  }): Promise<UserSummary & { disabled: boolean }> {
    const existing = await this.db
      .prepare(
        "SELECT id, username, email, is_admin, disabled, created_at FROM users WHERE oidc_issuer = ? AND oidc_subject = ?",
      )
      .bind(input.issuer, input.subject)
      .first<UserRow>();

    if (existing !== null) {
      // The provider is the authority on group membership, so administrator
      // status is re-read on every sign-in rather than frozen at creation.
      if (toUserSummary(existing).isAdmin !== input.isAdmin) {
        await this.db
          .prepare("UPDATE users SET is_admin = ?, updated_at = ? WHERE id = ?")
          .bind(flagValue(input.isAdmin), Date.now(), existing.id)
          .run();
      }
      return { ...toUserSummary(existing), isAdmin: input.isAdmin };
    }

    const now = Date.now();
    const id = crypto.randomUUID();
    const username = await this.availableUsername(input.username);

    // An address already held by another account is dropped rather than allowed
    // to fail the sign-in. Accounts are linked by (issuer, subject), never by
    // email, so the address is informational and its loss costs the new account
    // nothing an administrator cannot restore. Refusing to sign the user in
    // because a stranger claimed their address would cost rather more.
    const email = input.email === null ? null : await this.emailIfFree(input.email);

    await this.db
      .prepare(
        `INSERT INTO users
           (id, username, email, password_hash, is_admin, disabled, created_at, updated_at, oidc_issuer, oidc_subject)
         VALUES (?, ?, ?, 'external:oidc', ?, 0, ?, ?, ?, ?)`,
      )
      .bind(id, username, email, flagValue(input.isAdmin), now, now, input.issuer, input.subject)
      .run();

    return { id, username, email, isAdmin: input.isAdmin, disabled: false, createdAt: now };
  }

  private async emailIfFree(email: string): Promise<string | null> {
    return (await this.findUserIdByEmail(email)) === null ? email : null;
  }

  /** `alice`, then `alice-2`, and so on. A username is a namespace, and two people cannot share one. */
  private async availableUsername(preferred: string): Promise<string> {
    for (let suffix = 0; suffix < 50; suffix++) {
      const candidate = suffix === 0 ? preferred : `${preferred}-${suffix + 1}`;
      const taken = await this.db.prepare("SELECT 1 FROM users WHERE username = ?").bind(candidate).first();
      if (taken === null) return candidate;
    }
    return `user-${crypto.randomUUID().slice(0, 8)}`;
  }

  /**
   * Materialises the bootstrap administrator as a real row.
   *
   * The bootstrap admin authenticates against a secret, not the database, so it
   * has no `users` row - and access tokens carry a foreign key to one. Creating
   * the row on first use lets the operator issue tokens without first inventing
   * a second account.
   */
  async ensureBootstrapUser(username: string): Promise<void> {
    const now = Date.now();
    await this.db
      .prepare(
        `INSERT INTO users (id, username, email, password_hash, is_admin, disabled, created_at, updated_at)
         VALUES ('bootstrap', ?, NULL, 'external:bootstrap', 1, 0, ?, ?)
         ON CONFLICT (id) DO UPDATE SET username = excluded.username, updated_at = excluded.updated_at`,
      )
      .bind(username, now, now)
      .run();
  }
}
