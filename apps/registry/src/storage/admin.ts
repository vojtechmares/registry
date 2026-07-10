import type {
  AccessTokenSummary,
  LifecyclePolicy,
  ManifestDetail,
  RegistryStats,
  RepositoryDetail,
  RepositorySummary,
  TagSummary,
  UserSummary,
  Visibility,
} from "@registry/api-contract";
import { projectOf } from "@registry/projects";
import { parseScopes, type Scope } from "../auth/scopes.js";

/**
 * Escapes a literal for use inside a `LIKE` pattern, paired with `ESCAPE '\'`.
 *
 * `_` and `%` are `LIKE` wildcards, and a username may legitimately contain `_`.
 * Interpolating one unescaped turns the ownership filter `alice/%` into a
 * pattern that also matches a different tenant's namespace (`a_ice/%` matching
 * `alice`), disclosing repository names across tenants. Escaping keeps the
 * prefix a literal.
 */
function escapeLike(value: string): string {
  return value.replace(/[\\%_]/g, (char) => `\\${char}`);
}

function json<T>(raw: string | null): T | null {
  if (raw === null) return null;
  try {
    return JSON.parse(raw) as T;
  } catch {
    return null;
  }
}

export interface Viewer {
  readonly id: string;
  readonly username: string;
  readonly isAdmin: boolean;
}

/**
 * Who may see a repository, expressed once and joined through its project.
 *
 * An administrator sees everything. Anyone else sees the public projects, the
 * projects they are a member of, and the project named after them. An anonymous
 * caller sees only what is public. Returns null when no filter is needed.
 *
 * A fragment rather than a repeated clause, because `_catalog` and the
 * dashboard's repository list must never drift apart: one of them disclosing a
 * private repository name the other hides is a leak in whichever is wrong.
 */
function visibleProjects(viewer: Viewer | null, alias: string): { sql: string; bindings: unknown[] } | null {
  if (viewer === null) return { sql: `${alias}.visibility = 'public'`, bindings: [] };
  if (viewer.isAdmin) return null;
  return {
    sql: `(${alias}.visibility = 'public'
           OR ${alias}.name = ?
           OR EXISTS (SELECT 1 FROM project_members AS pm WHERE pm.project = ${alias}.name AND pm.user_id = ?))`,
    bindings: [viewer.username, viewer.id],
  };
}

/** Read and write paths for the dashboard, kept apart from the hot registry path. */
export class AdminStore {
  constructor(private readonly db: D1Database) {}

  /**
   * Three different totals, which are only equal in a registry that has never
   * deleted anything and never stored the same layer twice.
   *
   * `storageBytes` is what R2 holds, garbage included. `referencedBytes` is the
   * distinct content still linked. `logicalBytes` charges every repository for
   * every blob it links, so the gap between it and `referencedBytes` is exactly
   * what deduplication saved.
   */
  async stats(): Promise<RegistryStats> {
    const results = await this.db.batch<{ n: number; bytes?: number }>([
      this.db.prepare("SELECT COUNT(*) AS n FROM projects"),
      this.db.prepare("SELECT COUNT(*) AS n FROM repositories"),
      this.db.prepare("SELECT COUNT(*) AS n FROM tags"),
      this.db.prepare("SELECT COUNT(*) AS n FROM manifests"),
      this.db.prepare("SELECT COUNT(*) AS n, COALESCE(SUM(size), 0) AS bytes FROM blobs"),
      this.db.prepare(
        `SELECT COALESCE(SUM(size), 0) AS n FROM blobs
         WHERE EXISTS (SELECT 1 FROM repository_blobs AS rb WHERE rb.digest = blobs.digest)`,
      ),
      this.db.prepare(
        "SELECT COALESCE(SUM(b.size), 0) AS n FROM repository_blobs AS rb JOIN blobs AS b ON b.digest = rb.digest",
      ),
    ]);

    const count = (index: number): number => results[index]?.results[0]?.n ?? 0;
    const blobRow = results[4]?.results[0];
    const storageBytes = blobRow?.bytes ?? 0;
    const referencedBytes = count(5);

    return {
      projects: count(0),
      repositories: count(1),
      tags: count(2),
      manifests: count(3),
      blobs: blobRow?.n ?? 0,
      storageBytes,
      referencedBytes,
      logicalBytes: count(6),
      reclaimableBytes: Math.max(0, storageBytes - referencedBytes),
    };
  }

  /** Repositories the caller may see, filtered through their projects. */
  async listRepositories(options: {
    search: string | null;
    limit: number;
    project: string | null;
    visibleTo: Viewer | null;
  }): Promise<RepositorySummary[]> {
    const filters: string[] = [];
    const bindings: unknown[] = [];

    if (options.search !== null && options.search !== "") {
      filters.push("r.name LIKE ? ESCAPE '\\'");
      bindings.push(`%${escapeLike(options.search)}%`);
    }

    if (options.project !== null) {
      filters.push("r.project = ?");
      bindings.push(options.project);
    }

    const visible = visibleProjects(options.visibleTo, "p");
    if (visible !== null) {
      filters.push(visible.sql);
      bindings.push(...visible.bindings);
    }

    const where = filters.length === 0 ? "" : `WHERE ${filters.join(" AND ")}`;

    const rows = await this.db
      .prepare(
        `SELECT
           r.name,
           r.project,
           p.visibility,
           r.updated_at,
           (SELECT COUNT(*) FROM tags t WHERE t.repository = r.name) AS tags,
           (SELECT COUNT(*) FROM manifests m WHERE m.repository = r.name) AS manifests,
           (SELECT COALESCE(SUM(b.size), 0) FROM repository_blobs rb
              JOIN blobs b ON b.digest = rb.digest WHERE rb.repository = r.name) AS size_bytes
         FROM repositories AS r
         JOIN projects AS p ON p.name = r.project
         ${where}
         ORDER BY r.name ASC
         LIMIT ?`,
      )
      .bind(...bindings, options.limit)
      .all<{
        name: string;
        project: string;
        visibility: Visibility;
        updated_at: number;
        tags: number;
        manifests: number;
        size_bytes: number;
      }>();

    return rows.results.map((row) => ({
      name: row.name,
      project: row.project,
      visibility: row.visibility,
      tags: row.tags,
      manifests: row.manifests,
      sizeBytes: row.size_bytes,
      updatedAt: row.updated_at,
    }));
  }

  async repository(name: string): Promise<RepositoryDetail | null> {
    const row = await this.db
      .prepare(
        `SELECT r.name, r.project, p.visibility, r.created_at, r.updated_at
         FROM repositories AS r JOIN projects AS p ON p.name = r.project
         WHERE r.name = ?`,
      )
      .bind(name)
      .first<{
        name: string;
        project: string;
        visibility: Visibility;
        created_at: number;
        updated_at: number;
      }>();
    if (row === null) return null;

    const size = await this.db
      .prepare(
        `SELECT COALESCE(SUM(b.size), 0) AS bytes FROM repository_blobs rb
         JOIN blobs b ON b.digest = rb.digest WHERE rb.repository = ?`,
      )
      .bind(name)
      .first<{ bytes: number }>();

    return {
      name: row.name,
      project: row.project,
      visibility: row.visibility,
      sizeBytes: size?.bytes ?? 0,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
      tags: await this.tags(name),
    };
  }

  async tags(repository: string): Promise<TagSummary[]> {
    const rows = await this.db
      .prepare(
        `SELECT t.name, t.manifest_digest, t.updated_at, m.media_type, m.size
         FROM tags AS t
         LEFT JOIN manifests AS m ON m.repository = t.repository AND m.digest = t.manifest_digest
         WHERE t.repository = ?
         ORDER BY t.name ASC`,
      )
      .bind(repository)
      .all<{
        name: string;
        manifest_digest: string;
        updated_at: number;
        media_type: string | null;
        size: number | null;
      }>();

    return rows.results.map((row) => ({
      name: row.name,
      digest: row.manifest_digest,
      mediaType: row.media_type ?? "",
      sizeBytes: row.size ?? 0,
      updatedAt: row.updated_at,
    }));
  }

  async manifest(repository: string, digest: string): Promise<ManifestDetail | null> {
    const row = await this.db
      .prepare(
        `SELECT digest, media_type, artifact_type, size, subject_digest, annotations, created_at
         FROM manifests WHERE repository = ? AND digest = ?`,
      )
      .bind(repository, digest)
      .first<{
        digest: string;
        media_type: string;
        artifact_type: string | null;
        size: number;
        subject_digest: string | null;
        annotations: string | null;
        created_at: number;
      }>();
    if (row === null) return null;

    const [tags, blobs, referrers] = await Promise.all([
      this.db
        .prepare("SELECT name FROM tags WHERE repository = ? AND manifest_digest = ? ORDER BY name")
        .bind(repository, digest)
        .all<{ name: string }>(),
      this.db
        .prepare(
          `SELECT mb.blob_digest AS digest, COALESCE(b.size, 0) AS size
           FROM manifest_blobs mb LEFT JOIN blobs b ON b.digest = mb.blob_digest
           WHERE mb.repository = ? AND mb.manifest_digest = ?`,
        )
        .bind(repository, digest)
        .all<{ digest: string; size: number }>(),
      this.db
        .prepare(
          `SELECT digest, media_type, artifact_type, size, annotations
           FROM manifests WHERE repository = ? AND subject_digest = ? ORDER BY created_at`,
        )
        .bind(repository, digest)
        .all<{
          digest: string;
          media_type: string;
          artifact_type: string | null;
          size: number;
          annotations: string | null;
        }>(),
    ]);

    return {
      digest: row.digest,
      mediaType: row.media_type,
      artifactType: row.artifact_type,
      size: row.size,
      subjectDigest: row.subject_digest,
      annotations: json<Record<string, string>>(row.annotations),
      createdAt: row.created_at,
      tags: tags.results.map((tag) => tag.name),
      blobs: blobs.results,
      referrers: referrers.results.map((referrer) => ({
        digest: referrer.digest,
        mediaType: referrer.media_type,
        artifactType: referrer.artifact_type,
        size: referrer.size,
        annotations: json<Record<string, string>>(referrer.annotations),
      })),
    };
  }

  /**
   * Removes the repository's metadata and unlinks its content, then settles the
   * project's usage against the links that survive. The bytes stay in the
   * bucket until garbage collection confirms nothing else references them.
   */
  async deleteRepository(repository: string): Promise<boolean> {
    const project = projectOf(repository);
    const results = await this.db.batch([
      this.db.prepare("DELETE FROM tags WHERE repository = ?").bind(repository),
      this.db.prepare("DELETE FROM manifest_blobs WHERE repository = ?").bind(repository),
      this.db.prepare("DELETE FROM manifest_children WHERE repository = ?").bind(repository),
      this.db.prepare("DELETE FROM manifests WHERE repository = ?").bind(repository),
      this.db.prepare("DELETE FROM repository_blobs WHERE repository = ?").bind(repository),
      this.db.prepare("DELETE FROM lifecycle_policies WHERE repository = ?").bind(repository),
      this.db.prepare("DELETE FROM repositories WHERE name = ?").bind(repository),
      // In the same transaction as the unlinks, so the total can never be read
      // between the two and believed.
      this.db
        .prepare(
          `UPDATE projects
              SET used_bytes = COALESCE((
                    SELECT SUM(b.size)
                    FROM (SELECT DISTINCT digest FROM repository_blobs WHERE project = ?1) AS d
                    JOIN blobs AS b ON b.digest = d.digest
                  ), 0)
            WHERE name = ?1`,
        )
        .bind(project),
    ]);
    return (results[6]?.meta.changes ?? 0) > 0;
  }

  async policy(repository: string): Promise<LifecyclePolicy | null> {
    const row = await this.db
      .prepare(
        "SELECT repository, enabled, keep_last_tags, untagged_ttl_days FROM lifecycle_policies WHERE repository = ?",
      )
      .bind(repository)
      .first<{
        repository: string;
        enabled: number;
        keep_last_tags: number | null;
        untagged_ttl_days: number | null;
      }>();
    if (row === null) return null;
    return {
      repository: row.repository,
      enabled: row.enabled === 1,
      keepLastTags: row.keep_last_tags,
      untaggedTtlDays: row.untagged_ttl_days,
    };
  }

  async setPolicy(policy: LifecyclePolicy): Promise<void> {
    await this.db
      .prepare(
        `INSERT INTO lifecycle_policies (repository, enabled, keep_last_tags, untagged_ttl_days, updated_at)
         VALUES (?, ?, ?, ?, ?)
         ON CONFLICT (repository) DO UPDATE SET
           enabled = excluded.enabled,
           keep_last_tags = excluded.keep_last_tags,
           untagged_ttl_days = excluded.untagged_ttl_days,
           updated_at = excluded.updated_at`,
      )
      .bind(
        policy.repository,
        policy.enabled ? 1 : 0,
        policy.keepLastTags,
        policy.untaggedTtlDays,
        Date.now(),
      )
      .run();
  }

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
      revoked: row.revoked === 1,
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

  async listUsers(): Promise<UserSummary[]> {
    const rows = await this.db
      .prepare("SELECT id, username, email, is_admin, disabled, created_at FROM users ORDER BY username")
      .all<{
        id: string;
        username: string;
        email: string | null;
        is_admin: number;
        disabled: number;
        created_at: number;
      }>();

    return rows.results.map((row) => ({
      id: row.id,
      username: row.username,
      email: row.email,
      isAdmin: row.is_admin === 1,
      disabled: row.disabled === 1,
      createdAt: row.created_at,
    }));
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
      .bind(input.id, input.username, input.email, input.passwordHash, input.isAdmin ? 1 : 0, now, now)
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
      .first<{
        id: string;
        username: string;
        email: string | null;
        is_admin: number;
        disabled: number;
        created_at: number;
      }>();

    if (existing !== null) {
      // The provider is the authority on group membership, so administrator
      // status is re-read on every sign-in rather than frozen at creation.
      if ((existing.is_admin === 1) !== input.isAdmin) {
        await this.db
          .prepare("UPDATE users SET is_admin = ?, updated_at = ? WHERE id = ?")
          .bind(input.isAdmin ? 1 : 0, Date.now(), existing.id)
          .run();
      }
      return {
        id: existing.id,
        username: existing.username,
        email: existing.email,
        isAdmin: input.isAdmin,
        disabled: existing.disabled === 1,
        createdAt: existing.created_at,
      };
    }

    const now = Date.now();
    const id = crypto.randomUUID();
    const username = await this.availableUsername(input.username);

    await this.db
      .prepare(
        `INSERT INTO users
           (id, username, email, password_hash, is_admin, disabled, created_at, updated_at, oidc_issuer, oidc_subject)
         VALUES (?, ?, ?, 'external:oidc', ?, 0, ?, ?, ?, ?)`,
      )
      .bind(id, username, input.email, input.isAdmin ? 1 : 0, now, now, input.issuer, input.subject)
      .run();

    return { id, username, email: input.email, isAdmin: input.isAdmin, disabled: false, createdAt: now };
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

  /**
   * Repository names for `GET /v2/_catalog`.
   *
   * A caller only ever sees what they could pull. Listing a private name is
   * itself a disclosure, so the filter belongs in the query rather than in the
   * caller, and it is the same filter the dashboard's listing uses.
   */
  async catalog(
    limit: number,
    last: string | null,
    viewer: Viewer | null,
    project: string | null = null,
  ): Promise<{ names: string[]; hasMore: boolean }> {
    const conditions: string[] = [];
    const bindings: unknown[] = [];

    if (last !== null) {
      conditions.push("r.name > ?");
      bindings.push(last);
    }

    // A project-pinned token confines the whole catalog to its project.
    if (project !== null) {
      conditions.push("r.project = ?");
      bindings.push(project);
    }

    const visible = visibleProjects(viewer, "p");
    if (visible !== null) {
      conditions.push(visible.sql);
      bindings.push(...visible.bindings);
    }

    const where = conditions.length === 0 ? "" : `WHERE ${conditions.join(" AND ")}`;

    const rows = await this.db
      .prepare(
        `SELECT r.name FROM repositories AS r
         JOIN projects AS p ON p.name = r.project
         ${where} ORDER BY r.name ASC LIMIT ?`,
      )
      .bind(...bindings, limit + 1)
      .all<{ name: string }>();

    const names = rows.results.map((row) => row.name);
    const hasMore = names.length > limit;
    return { names: hasMore ? names.slice(0, limit) : names, hasMore };
  }
}
