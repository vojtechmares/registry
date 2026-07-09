import type { Env } from "../env.js";
import { MANIFEST_PREFIX, STAGING_PREFIX, UPLOAD_PREFIX } from "../keys.js";

/**
 * A blob exists in R2 for a moment before the metadata store links it: the
 * upload writes the object, then registers and links it in one transaction.
 * Only content unreferenced for longer than this is reclaimable, so a push in
 * flight is never collected out from under itself. Milliseconds separate the
 * write from the commit; an hour is generous.
 */
const BLOB_GRACE_MS = 60 * 60 * 1000;

/**
 * An open upload session, by contrast, may legitimately sit idle between chunks
 * for a long time. This must not undercut the session's own 24-hour expiry, or
 * the collector would delete the carry object of an upload still in progress.
 */
const UPLOAD_GRACE_MS = 25 * 60 * 60 * 1000;

/** Bounds a single cron invocation. Whatever is missed is collected tomorrow. */
const BATCH = 200;
const MAX_LIST_PAGES = 20;

export interface GarbageReport {
  readonly blobs: number;
  readonly manifests: number;
  readonly abandonedUploads: number;
}

/**
 * Reclaims content nothing points at any more.
 *
 * Every deletion re-validates rather than trusting the candidate list, because
 * a push may arrive between the scan and the delete. The row goes first, and
 * only conditionally: if a repository linked the blob in the meantime the
 * DELETE matches nothing and the content is left alone. The bytes go second,
 * and only once no surviving row names that key - blobs are content-addressed,
 * so a re-push of the same digest lands on the very key we were about to erase.
 */
export async function collectGarbage(env: Env): Promise<GarbageReport> {
  const now = Date.now();

  const blobs = await collectUnreferencedBlobs(env, now - BLOB_GRACE_MS);
  const manifests = await collectOrphanedManifestObjects(env, now - BLOB_GRACE_MS);
  const abandonedUploads = await collectAbandonedUploads(env, now - UPLOAD_GRACE_MS);

  return { blobs, manifests, abandonedUploads };
}

async function collectUnreferencedBlobs(env: Env, cutoff: number): Promise<number> {
  const rows = await env.DB.prepare(
    `SELECT digest, storage_key FROM blobs
     WHERE created_at < ?
       AND NOT EXISTS (SELECT 1 FROM repository_blobs AS rb WHERE rb.digest = blobs.digest)
     LIMIT ?`,
  )
    .bind(cutoff, BATCH)
    .all<{ digest: string; storage_key: string }>();

  let collected = 0;

  for (const row of rows.results) {
    // Snapshot the object before touching anything. Blobs are content-addressed,
    // so a concurrent re-push of the same digest rewrites this exact key with a
    // fresh upload time - comparing against that snapshot just before the delete
    // is what tells a genuine orphan apart from a live re-push.
    const before = await env.BUCKET.head(row.storage_key);

    // Delete the row conditionally. A push that re-linked or re-pushed the blob
    // since the scan has bumped `created_at` past the cutoff (or added a link),
    // so the DELETE matches nothing and we move on.
    const deleted = await env.DB.prepare(
      `DELETE FROM blobs
       WHERE digest = ? AND created_at < ?
         AND NOT EXISTS (SELECT 1 FROM repository_blobs AS rb WHERE rb.digest = blobs.digest)`,
    )
      .bind(row.digest, cutoff)
      .run();

    if ((deleted.meta.changes ?? 0) === 0) continue;

    // Two guards on the object delete, both catching a re-push. No surviving row
    // may name the key, and the object must not have been rewritten since the
    // snapshot. Together they close all but a single-operation non-atomic window.
    const claimed = await env.DB.prepare("SELECT 1 AS n FROM blobs WHERE storage_key = ? LIMIT 1")
      .bind(row.storage_key)
      .first();
    const after = await env.BUCKET.head(row.storage_key);
    const unchanged =
      before !== null && after !== null && before.uploaded.getTime() === after.uploaded.getTime();

    if (claimed === null && unchanged) {
      await env.BUCKET.delete(row.storage_key);
    }

    await env.DB.prepare(
      "INSERT INTO lifecycle_events (repository, action, subject, reason, created_at) VALUES (?,?,?,?,?)",
    )
      .bind(null, "collect-blob", row.digest, "no repository links this blob", Date.now())
      .run();

    collected++;
  }

  return collected;
}

/**
 * Manifest bytes are content-addressed and shared across repositories, so an
 * object is garbage only once no repository holds a manifest with that digest.
 * There is no manifest-content table to scan, so this walks the bucket.
 */
async function collectOrphanedManifestObjects(env: Env, cutoff: number): Promise<number> {
  let cursor: string | undefined;
  let deleted = 0;

  for (let page = 0; page < MAX_LIST_PAGES; page++) {
    const listing = await env.BUCKET.list({
      prefix: MANIFEST_PREFIX,
      limit: BATCH,
      ...(cursor === undefined ? {} : { cursor }),
    });

    const candidates = listing.objects.filter((object) => object.uploaded.getTime() < cutoff);
    if (candidates.length > 0) {
      const digests = candidates.map((object) => keyToDigest(object.key, MANIFEST_PREFIX));
      const live = await liveManifestDigests(env, digests);

      for (const object of candidates) {
        if (live.has(keyToDigest(object.key, MANIFEST_PREFIX))) continue;
        // The listing is a snapshot. A push that rewrote this manifest since
        // then makes it young again, and the row it inserted may not have been
        // visible to the liveness query above.
        if (!(await stillStale(env, object.key, cutoff))) continue;
        await env.BUCKET.delete(object.key);
        deleted++;
      }
    }

    if (!listing.truncated) break;
    cursor = listing.cursor;
  }

  return deleted;
}

async function liveManifestDigests(env: Env, digests: readonly string[]): Promise<Set<string>> {
  if (digests.length === 0) return new Set();
  const placeholders = new Array(digests.length).fill("?").join(", ");
  const rows = await env.DB.prepare(`SELECT DISTINCT digest FROM manifests WHERE digest IN (${placeholders})`)
    .bind(...digests)
    .all<{ digest: string }>();
  return new Set(rows.results.map((row) => row.digest));
}

/**
 * Sweeps carry objects and staged multipart bodies left behind by uploads that
 * were never closed. The upload session's own alarm normally handles this; this
 * catches the case where the Durable Object's storage was lost.
 */
async function collectAbandonedUploads(env: Env, cutoff: number): Promise<number> {
  let deleted = 0;

  for (const prefix of [UPLOAD_PREFIX, STAGING_PREFIX]) {
    let cursor: string | undefined;

    for (let page = 0; page < MAX_LIST_PAGES; page++) {
      const listing = await env.BUCKET.list({
        prefix,
        limit: BATCH,
        ...(cursor === undefined ? {} : { cursor }),
      });

      const stale = listing.objects.filter((object) => object.uploaded.getTime() < cutoff);
      if (stale.length > 0) {
        // A staged object becomes a real blob by being registered under its own
        // key, so anything the blobs table still names must be left alone.
        const referenced = await referencedStorageKeys(
          env,
          stale.map((object) => object.key),
        );
        for (const object of stale) {
          if (referenced.has(object.key)) continue;
          if (!(await stillStale(env, object.key, cutoff))) continue;
          await env.BUCKET.delete(object.key);
          deleted++;
        }
      }

      if (!listing.truncated) break;
      cursor = listing.cursor;
    }
  }

  return deleted;
}

async function referencedStorageKeys(env: Env, keys: readonly string[]): Promise<Set<string>> {
  if (keys.length === 0) return new Set();
  const placeholders = new Array(keys.length).fill("?").join(", ");
  const rows = await env.DB.prepare(`SELECT storage_key FROM blobs WHERE storage_key IN (${placeholders})`)
    .bind(...keys)
    .all<{ storage_key: string }>();
  return new Set(rows.results.map((row) => row.storage_key));
}

/** True when the object still carries the age that made it a candidate. */
async function stillStale(env: Env, key: string, cutoff: number): Promise<boolean> {
  const current = await env.BUCKET.head(key);
  return current !== null && current.uploaded.getTime() < cutoff;
}

/** `manifests/sha256/<hex>` back to `sha256:<hex>`. */
function keyToDigest(key: string, prefix: string): string {
  return key.slice(prefix.length).replace("/", ":");
}
