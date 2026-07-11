import type { ProjectDetail, ProjectMember, ProjectSettings, ProjectSummary } from "@registry/api-contract";
import { type Role, type Visibility, isRole } from "@registry/projects";
import { type Audience, visibleProjectsFilter } from "../visibility.js";

interface ProjectRow {
  name: string;
  visibility: Visibility;
  description: string | null;
  quota_bytes: number | null;
  used_bytes: number;
  require_signature_push: number;
  require_signature_pull: number;
  immutable_tags: number;
  repositories: number;
  created_at: number;
  updated_at: number;
  role: string | null;
}

const COLUMNS = `
  p.name,
  p.visibility,
  p.description,
  p.quota_bytes,
  p.used_bytes,
  p.require_signature_push,
  p.require_signature_pull,
  p.immutable_tags,
  p.created_at,
  p.updated_at,
  (SELECT COUNT(*) FROM repositories AS r WHERE r.project = p.name) AS repositories,
  m.role
`;

function toSummary(row: ProjectRow): ProjectSummary {
  return {
    name: row.name,
    visibility: row.visibility,
    description: row.description,
    quotaBytes: row.quota_bytes,
    usedBytes: row.used_bytes,
    requireSignaturePush: row.require_signature_push === 1,
    requireSignaturePull: row.require_signature_pull === 1,
    immutableTags: row.immutable_tags === 1,
    repositories: row.repositories,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    role: row.role !== null && isRole(row.role) ? row.role : null,
  };
}

/**
 * The rules that decide a project's push and pull behaviour, fetched on the
 * registry's critical path. Deliberately narrower than `ProjectSummary`: the
 * policy hooks want three integers, not a repository count.
 */
export interface ProjectRules {
  readonly name: string;
  readonly quotaBytes: number | null;
  readonly usedBytes: number;
  readonly requireSignaturePush: boolean;
  readonly requireSignaturePull: boolean;
  readonly immutableTags: boolean;
}

export class ProjectStore {
  constructor(private readonly db: D1Database) {}

  async rules(project: string): Promise<ProjectRules | null> {
    const row = await this.db
      .prepare(
        `SELECT name, quota_bytes, used_bytes, require_signature_push, require_signature_pull, immutable_tags
         FROM projects WHERE name = ?`,
      )
      .bind(project)
      .first<{
        name: string;
        quota_bytes: number | null;
        used_bytes: number;
        require_signature_push: number;
        require_signature_pull: number;
        immutable_tags: number;
      }>();
    if (row === null) return null;
    return {
      name: row.name,
      quotaBytes: row.quota_bytes,
      usedBytes: row.used_bytes,
      requireSignaturePush: row.require_signature_push === 1,
      requireSignaturePull: row.require_signature_pull === 1,
      immutableTags: row.immutable_tags === 1,
    };
  }

  /**
   * Projects the audience may see, through the one visibility rule. The join to
   * `project_members` stays for the caller's own `role` in each row; the
   * visibility filter itself is the module's, so this listing cannot drift from
   * the catalog or the predicate.
   */
  async list(audience: Audience): Promise<ProjectSummary[]> {
    const filter = visibleProjectsFilter(audience, "p");
    const where = filter === null ? "" : `WHERE ${filter.sql}`;
    const rows = await this.db
      .prepare(
        `SELECT ${COLUMNS}
         FROM projects AS p
         LEFT JOIN project_members AS m ON m.project = p.name AND m.user_id = ?
         ${where}
         ORDER BY p.name ASC`,
      )
      .bind(audience.viewer?.id ?? null, ...(filter?.bindings ?? []))
      .all<ProjectRow>();

    return rows.results.map(toSummary);
  }

  async get(name: string, viewerId: string | null): Promise<ProjectDetail | null> {
    const row = await this.db
      .prepare(
        `SELECT ${COLUMNS}
         FROM projects AS p
         LEFT JOIN project_members AS m ON m.project = p.name AND m.user_id = ?
         WHERE p.name = ?`,
      )
      .bind(viewerId, name)
      .first<ProjectRow>();
    if (row === null) return null;

    return { ...toSummary(row), members: await this.members(name) };
  }

  async members(project: string): Promise<ProjectMember[]> {
    const rows = await this.db
      .prepare(
        `SELECT m.user_id, u.username, m.role, m.created_at
         FROM project_members AS m
         JOIN users AS u ON u.id = m.user_id
         WHERE m.project = ?
         ORDER BY u.username ASC`,
      )
      .bind(project)
      .all<{ user_id: string; username: string; role: string; created_at: number }>();

    return rows.results.flatMap((row): ProjectMember[] =>
      isRole(row.role)
        ? [{ userId: row.user_id, username: row.username, role: row.role, createdAt: row.created_at }]
        : [],
    );
  }

  async exists(name: string): Promise<boolean> {
    return (await this.db.prepare("SELECT 1 FROM projects WHERE name = ?").bind(name).first()) !== null;
  }

  /**
   * Whether linking `digest` into `project` would add to what it stores.
   *
   * False when some repository in the project already links the blob: the bytes
   * are counted once per project, so the second link is free. This is what a
   * quota check consults before admitting an upload, and it is advisory - the
   * charge itself is applied inside the transaction that creates the link.
   */
  async charges(project: string, digest: string): Promise<boolean> {
    const row = await this.db
      .prepare("SELECT 1 FROM repository_blobs WHERE project = ? AND digest = ? LIMIT 1")
      .bind(project, digest)
      .first();
    return row === null;
  }

  /**
   * Creates a project, with its creator as owner. Returns false when the name is
   * taken - the caller turns that into a 409 rather than silently adopting
   * someone else's project.
   */
  async create(input: {
    name: string;
    visibility: Visibility;
    description: string | null;
    quotaBytes: number | null;
    ownerId: string | null;
  }): Promise<boolean> {
    const now = Date.now();

    // The creator is made owner only once the insert proves the project is new.
    // Batching the two would hand ownership of an existing project to whoever
    // guessed its name, because `DO NOTHING` reports success just as quietly as
    // it reports having done nothing.
    const created = await this.db
      .prepare(
        `INSERT INTO projects (name, visibility, description, quota_bytes, used_bytes, created_at, updated_at)
         VALUES (?, ?, ?, ?, 0, ?, ?)
         ON CONFLICT (name) DO NOTHING`,
      )
      .bind(input.name, input.visibility, input.description, input.quotaBytes, now, now)
      .run();

    if ((created.meta.changes ?? 0) === 0) return false;

    if (input.ownerId !== null) {
      await this.db
        .prepare(
          `INSERT INTO project_members (project, user_id, role, created_at)
           SELECT ?, ?, 'owner', ?
           WHERE EXISTS (SELECT 1 FROM users WHERE id = ?)`,
        )
        .bind(input.name, input.ownerId, now, input.ownerId)
        .run();
    }
    return true;
  }

  /** Applies only the fields the caller supplied. Absent means unchanged; null means cleared. */
  async update(name: string, settings: ProjectSettings): Promise<boolean> {
    const assignments: string[] = [];
    const bindings: unknown[] = [];

    if (settings.visibility !== undefined) {
      assignments.push("visibility = ?");
      bindings.push(settings.visibility);
    }
    if (settings.description !== undefined) {
      assignments.push("description = ?");
      bindings.push(settings.description);
    }
    if (settings.quotaBytes !== undefined) {
      assignments.push("quota_bytes = ?");
      bindings.push(settings.quotaBytes);
    }
    if (settings.requireSignaturePush !== undefined) {
      assignments.push("require_signature_push = ?");
      bindings.push(settings.requireSignaturePush ? 1 : 0);
    }
    if (settings.requireSignaturePull !== undefined) {
      assignments.push("require_signature_pull = ?");
      bindings.push(settings.requireSignaturePull ? 1 : 0);
    }
    if (settings.immutableTags !== undefined) {
      assignments.push("immutable_tags = ?");
      bindings.push(settings.immutableTags ? 1 : 0);
    }
    if (assignments.length === 0) return this.exists(name);

    assignments.push("updated_at = ?");
    bindings.push(Date.now(), name);

    const result = await this.db
      .prepare(`UPDATE projects SET ${assignments.join(", ")} WHERE name = ?`)
      .bind(...bindings)
      .run();
    return (result.meta.changes ?? 0) > 0;
  }

  /**
   * Removes the project and everything filed under it. Blob content survives
   * until garbage collection confirms nothing else links it.
   */
  async remove(name: string): Promise<boolean> {
    const results = await this.db.batch([
      this.db
        .prepare("DELETE FROM tags WHERE repository IN (SELECT name FROM repositories WHERE project = ?)")
        .bind(name),
      this.db
        .prepare(
          "DELETE FROM manifest_blobs WHERE repository IN (SELECT name FROM repositories WHERE project = ?)",
        )
        .bind(name),
      this.db
        .prepare(
          "DELETE FROM manifest_children WHERE repository IN (SELECT name FROM repositories WHERE project = ?)",
        )
        .bind(name),
      this.db
        .prepare(
          "DELETE FROM manifests WHERE repository IN (SELECT name FROM repositories WHERE project = ?)",
        )
        .bind(name),
      this.db
        .prepare(
          "DELETE FROM lifecycle_policies WHERE repository IN (SELECT name FROM repositories WHERE project = ?)",
        )
        .bind(name),
      this.db.prepare("DELETE FROM repository_blobs WHERE project = ?").bind(name),
      this.db.prepare("DELETE FROM repositories WHERE project = ?").bind(name),
      this.db.prepare("DELETE FROM project_members WHERE project = ?").bind(name),
      this.db.prepare("DELETE FROM projects WHERE name = ?").bind(name),
    ]);
    return (results[8]?.meta.changes ?? 0) > 0;
  }

  async setMember(project: string, userId: string, role: Role): Promise<void> {
    await this.db
      .prepare(
        `INSERT INTO project_members (project, user_id, role, created_at)
         VALUES (?, ?, ?, ?)
         ON CONFLICT (project, user_id) DO UPDATE SET role = excluded.role`,
      )
      .bind(project, userId, role, Date.now())
      .run();
  }

  async removeMember(project: string, userId: string): Promise<boolean> {
    const result = await this.db
      .prepare("DELETE FROM project_members WHERE project = ? AND user_id = ?")
      .bind(project, userId)
      .run();
    return (result.meta.changes ?? 0) > 0;
  }

  /** How many owners the project has, so the last one cannot be removed by accident. */
  async ownerCount(project: string): Promise<number> {
    const row = await this.db
      .prepare("SELECT COUNT(*) AS n FROM project_members WHERE project = ? AND role = 'owner'")
      .bind(project)
      .first<{ n: number }>();
    return row?.n ?? 0;
  }

  /**
   * Recomputes `used_bytes` from the links that remain.
   *
   * The incremental accounting on the push path is exact, but it only ever sees
   * one blob at a time. Anything that removes many links at once - dropping a
   * repository, collecting garbage - settles up here instead.
   */
  async recalculateUsage(project: string): Promise<void> {
    await this.db
      .prepare(
        `UPDATE projects
            SET used_bytes = COALESCE((
                  SELECT SUM(b.size)
                  FROM (SELECT DISTINCT digest FROM repository_blobs WHERE project = ?1) AS d
                  JOIN blobs AS b ON b.digest = d.digest
                ), 0)
          WHERE name = ?1`,
      )
      .bind(project)
      .run();
  }
}
