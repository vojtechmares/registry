import type {
  BlobRecord,
  ManifestRecord,
  MetadataStore,
  ReferrerRecord,
  TagPage,
} from "@registry/registry-core";
import { placeholders } from "./sql.js";

interface BlobRow {
  digest: string;
  size: number;
  storage_key: string;
}

interface ManifestRow {
  digest: string;
  media_type: string;
  artifact_type: string | null;
  size: number;
  subject_digest: string | null;
  annotations: string | null;
}

function parseAnnotations(raw: string | null): Record<string, string> | null {
  if (raw === null) return null;
  try {
    const parsed: unknown = JSON.parse(raw);
    return typeof parsed === "object" && parsed !== null ? (parsed as Record<string, string>) : null;
  } catch {
    return null;
  }
}

function toManifestRecord(row: ManifestRow): ManifestRecord {
  return {
    digest: row.digest,
    mediaType: row.media_type,
    size: row.size,
    artifactType: row.artifact_type,
    subjectDigest: row.subject_digest,
    annotations: parseAnnotations(row.annotations),
  };
}

export class D1MetadataStore implements MetadataStore {
  constructor(private readonly db: D1Database) {}

  private now(): number {
    return Date.now();
  }

  async repositoryExists(repository: string): Promise<boolean> {
    const row = await this.db.prepare("SELECT 1 FROM repositories WHERE name = ?").bind(repository).first();
    return row !== null;
  }

  async ensureRepository(repository: string): Promise<void> {
    const now = this.now();
    await this.db
      .prepare(
        `INSERT INTO repositories (name, visibility, created_at, updated_at)
         VALUES (?, ?, ?, ?)
         ON CONFLICT (name) DO UPDATE SET updated_at = excluded.updated_at`,
      )
      .bind(repository, "private", now, now)
      .run();
  }

  async getBlob(digest: string): Promise<BlobRecord | null> {
    const row = await this.db
      .prepare("SELECT digest, size, storage_key FROM blobs WHERE digest = ?")
      .bind(digest)
      .first<BlobRow>();
    return row === null ? null : { digest: row.digest, size: row.size, storageKey: row.storage_key };
  }

  async repositoriesLinkingBlob(digest: string, limit: number): Promise<string[]> {
    const rows = await this.db
      .prepare("SELECT repository FROM repository_blobs WHERE digest = ? ORDER BY repository LIMIT ?")
      .bind(digest, limit)
      .all<{ repository: string }>();
    return rows.results.map((row) => row.repository);
  }

  async getLinkedBlob(repository: string, digest: string): Promise<BlobRecord | null> {
    const row = await this.db
      .prepare(
        `SELECT b.digest, b.size, b.storage_key
         FROM repository_blobs AS rb
         JOIN blobs AS b ON b.digest = rb.digest
         WHERE rb.repository = ? AND rb.digest = ?`,
      )
      .bind(repository, digest)
      .first<BlobRow>();
    return row === null ? null : { digest: row.digest, size: row.size, storageKey: row.storage_key };
  }

  /**
   * Deduplication point.
   *
   * `DO NOTHING` lets a concurrent upload of identical bytes win harmlessly, and
   * the following SELECT tells the caller whose object survived so the loser can
   * delete the one it just wrote.
   *
   * The insert and the link share one batch, which D1 runs as a transaction.
   * That is what makes the blob safe from garbage collection: the collector only
   * removes a row that has no link, and it can never observe this blob in the
   * window between the two statements because there is no such window.
   */
  async registerAndLinkBlob(repository: string, record: BlobRecord): Promise<BlobRecord> {
    const now = this.now();
    await this.db.batch([
      this.db
        .prepare(
          `INSERT INTO blobs (digest, size, storage_key, created_at)
           VALUES (?, ?, ?, ?)
           ON CONFLICT (digest) DO UPDATE SET created_at = excluded.created_at`,
        )
        .bind(record.digest, record.size, record.storageKey, now),
      this.db
        .prepare(
          `INSERT INTO repository_blobs (repository, digest, created_at)
           VALUES (?, ?, ?)
           ON CONFLICT (repository, digest) DO NOTHING`,
        )
        .bind(repository, record.digest, now),
    ]);

    // Safe to read after the fact: the link now exists, so nothing may delete the row.
    const stored = await this.getBlob(record.digest);
    return stored ?? record;
  }

  /**
   * Links a blob that already exists. The `WHERE EXISTS` guard makes this a
   * no-op when the blob has just been collected, so a cross-mount can never
   * leave a repository pointing at content the registry no longer holds.
   */
  async linkBlob(repository: string, digest: string): Promise<boolean> {
    const result = await this.db
      .prepare(
        `INSERT INTO repository_blobs (repository, digest, created_at)
         SELECT ?, ?, ? WHERE EXISTS (SELECT 1 FROM blobs WHERE digest = ?)
         ON CONFLICT (repository, digest) DO NOTHING`,
      )
      .bind(repository, digest, this.now(), digest)
      .run();

    // An existing link changes nothing, yet the blob is plainly linked.
    if ((result.meta.changes ?? 0) > 0) return true;
    return (await this.getLinkedBlob(repository, digest)) !== null;
  }

  async unlinkBlob(repository: string, digest: string): Promise<boolean> {
    const result = await this.db
      .prepare("DELETE FROM repository_blobs WHERE repository = ? AND digest = ?")
      .bind(repository, digest)
      .run();
    return (result.meta.changes ?? 0) > 0;
  }

  async missingLinkedBlobs(repository: string, digests: readonly string[]): Promise<string[]> {
    if (digests.length === 0) return [];
    const unique = [...new Set(digests)];
    const rows = await this.db
      .prepare(
        `SELECT digest FROM repository_blobs
         WHERE repository = ? AND digest IN (${placeholders(unique.length)})`,
      )
      .bind(repository, ...unique)
      .all<{ digest: string }>();

    const present = new Set(rows.results.map((row) => row.digest));
    return unique.filter((digest) => !present.has(digest));
  }

  async getManifest(repository: string, digest: string): Promise<ManifestRecord | null> {
    const row = await this.db
      .prepare(
        `SELECT digest, media_type, artifact_type, size, subject_digest, annotations
         FROM manifests WHERE repository = ? AND digest = ?`,
      )
      .bind(repository, digest)
      .first<ManifestRow>();
    return row === null ? null : toManifestRecord(row);
  }

  async missingManifests(repository: string, digests: readonly string[]): Promise<string[]> {
    if (digests.length === 0) return [];
    const unique = [...new Set(digests)];
    const rows = await this.db
      .prepare(
        `SELECT digest FROM manifests WHERE repository = ? AND digest IN (${placeholders(unique.length)})`,
      )
      .bind(repository, ...unique)
      .all<{ digest: string }>();

    const present = new Set(rows.results.map((row) => row.digest));
    return unique.filter((digest) => !present.has(digest));
  }

  async resolveTag(repository: string, tag: string): Promise<string | null> {
    const row = await this.db
      .prepare("SELECT manifest_digest FROM tags WHERE repository = ? AND name = ?")
      .bind(repository, tag)
      .first<{ manifest_digest: string }>();
    return row?.manifest_digest ?? null;
  }

  async putManifest(
    repository: string,
    record: ManifestRecord,
    references: { readonly blobs: readonly string[]; readonly manifests: readonly string[] },
  ): Promise<void> {
    const now = this.now();
    const statements: D1PreparedStatement[] = [
      this.db
        .prepare(
          `INSERT INTO manifests
             (repository, digest, media_type, artifact_type, size, subject_digest, annotations, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?)
           ON CONFLICT (repository, digest) DO UPDATE SET
             media_type = excluded.media_type,
             artifact_type = excluded.artifact_type,
             size = excluded.size,
             subject_digest = excluded.subject_digest,
             annotations = excluded.annotations`,
        )
        .bind(
          repository,
          record.digest,
          record.mediaType,
          record.artifactType,
          record.size,
          record.subjectDigest,
          record.annotations === null ? null : JSON.stringify(record.annotations),
          now,
        ),
      // Re-pushing an identical manifest must not accumulate duplicate edges.
      this.db
        .prepare("DELETE FROM manifest_blobs WHERE repository = ? AND manifest_digest = ?")
        .bind(repository, record.digest),
      this.db
        .prepare("DELETE FROM manifest_children WHERE repository = ? AND manifest_digest = ?")
        .bind(repository, record.digest),
    ];

    for (const blob of new Set(references.blobs)) {
      statements.push(
        this.db
          .prepare("INSERT INTO manifest_blobs (repository, manifest_digest, blob_digest) VALUES (?, ?, ?)")
          .bind(repository, record.digest, blob),
      );
    }
    for (const child of new Set(references.manifests)) {
      statements.push(
        this.db
          .prepare(
            "INSERT INTO manifest_children (repository, manifest_digest, child_digest) VALUES (?, ?, ?)",
          )
          .bind(repository, record.digest, child),
      );
    }

    await this.db.batch(statements);
  }

  async tagManifest(repository: string, tag: string, digest: string): Promise<void> {
    const now = this.now();
    await this.db
      .prepare(
        `INSERT INTO tags (repository, name, manifest_digest, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?)
         ON CONFLICT (repository, name) DO UPDATE SET
           manifest_digest = excluded.manifest_digest,
           updated_at = excluded.updated_at`,
      )
      .bind(repository, tag, digest, now, now)
      .run();
  }

  /** Removes the manifest, its reference edges, and every tag that pointed at it. */
  async deleteManifest(repository: string, digest: string): Promise<boolean> {
    const results = await this.db.batch([
      this.db
        .prepare("DELETE FROM tags WHERE repository = ? AND manifest_digest = ?")
        .bind(repository, digest),
      this.db
        .prepare("DELETE FROM manifest_blobs WHERE repository = ? AND manifest_digest = ?")
        .bind(repository, digest),
      this.db
        .prepare("DELETE FROM manifest_children WHERE repository = ? AND manifest_digest = ?")
        .bind(repository, digest),
      this.db.prepare("DELETE FROM manifests WHERE repository = ? AND digest = ?").bind(repository, digest),
    ]);

    return (results[3]?.meta.changes ?? 0) > 0;
  }

  async deleteTag(repository: string, tag: string): Promise<boolean> {
    const result = await this.db
      .prepare("DELETE FROM tags WHERE repository = ? AND name = ?")
      .bind(repository, tag)
      .run();
    return (result.meta.changes ?? 0) > 0;
  }

  /** Tags come back in SQLite's BINARY collation, which is the spec's lexical order. */
  async listTags(repository: string, options: { limit: number; last?: string }): Promise<TagPage> {
    // Fetch one extra row to learn whether a `Link` header is warranted.
    const limit = options.limit + 1;
    const rows =
      options.last === undefined
        ? await this.db
            .prepare("SELECT name FROM tags WHERE repository = ? ORDER BY name ASC LIMIT ?")
            .bind(repository, limit)
            .all<{ name: string }>()
        : await this.db
            .prepare("SELECT name FROM tags WHERE repository = ? AND name > ? ORDER BY name ASC LIMIT ?")
            .bind(repository, options.last, limit)
            .all<{ name: string }>();

    const names = rows.results.map((row) => row.name);
    const hasMore = names.length > options.limit;
    return { tags: hasMore ? names.slice(0, options.limit) : names, hasMore };
  }

  async listReferrers(repository: string, subjectDigest: string): Promise<ReferrerRecord[]> {
    const rows = await this.db
      .prepare(
        `SELECT digest, media_type, artifact_type, size, annotations
         FROM manifests
         WHERE repository = ? AND subject_digest = ?
         ORDER BY created_at ASC, digest ASC`,
      )
      .bind(repository, subjectDigest)
      .all<Omit<ManifestRow, "subject_digest">>();

    return rows.results.map((row) => ({
      digest: row.digest,
      mediaType: row.media_type,
      size: row.size,
      artifactType: row.artifact_type,
      annotations: parseAnnotations(row.annotations),
    }));
  }
}
