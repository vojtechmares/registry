import type {
  LifecyclePolicy,
  ManifestDetail,
  RegistryStats,
  RepositoryDetail,
  RepositorySummary,
  TagSummary,
  Visibility,
} from "@registry/api-contract";
import { projectOf } from "@registry/projects";
import { type Audience, visibleProjectsFilter } from "../visibility.js";
import { REPOSITORY_CONTENT_TABLES, deleteRepositoryContent, recomputeUsage } from "./cascade.js";
import { flag, flagValue, jsonObject } from "./codec.js";

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

/** Repository reads, deletion, the `_catalog` listing, and registry-wide stats. */
export class RepositoryStore {
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
    audience: Audience;
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

    const visible = visibleProjectsFilter(options.audience, "p");
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
      annotations: jsonObject<Record<string, string>>(row.annotations),
      createdAt: row.created_at,
      tags: tags.results.map((tag) => tag.name),
      blobs: blobs.results,
      referrers: referrers.results.map((referrer) => ({
        digest: referrer.digest,
        mediaType: referrer.media_type,
        artifactType: referrer.artifact_type,
        size: referrer.size,
        annotations: jsonObject<Record<string, string>>(referrer.annotations),
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
      ...deleteRepositoryContent(this.db, repository),
      this.db.prepare("DELETE FROM repositories WHERE name = ?").bind(repository),
      // In the same transaction as the unlinks, so the total can never be read
      // between the two and believed.
      recomputeUsage(this.db, project),
    ]);
    return (results[REPOSITORY_CONTENT_TABLES.length]?.meta.changes ?? 0) > 0;
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
      enabled: flag(row.enabled),
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
        flagValue(policy.enabled),
        policy.keepLastTags,
        policy.untaggedTtlDays,
        Date.now(),
      )
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
    audience: Audience,
  ): Promise<{ names: string[]; hasMore: boolean }> {
    const conditions: string[] = [];
    const bindings: unknown[] = [];

    if (last !== null) {
      conditions.push("r.name > ?");
      bindings.push(last);
    }

    // The audience carries the pin, so a project-pinned token is confined to its
    // project by the same filter that hides private names.
    const visible = visibleProjectsFilter(audience, "p");
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
