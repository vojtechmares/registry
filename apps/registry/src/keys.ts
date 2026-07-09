/**
 * Object-store key layout.
 *
 * Blob content lives under `blobs/`, manifests under `manifests/`, and the
 * transient state of an in-flight upload under `blobs/staged/` and `uploads/`.
 * Garbage collection is driven by the metadata store rather than by scanning a
 * prefix: it reclaims an object once no row names its key.
 */

/** Content-addressed, used whenever the digest is known before the bytes land. */
export function blobKey(digest: string): string {
  return `blobs/${digest.replace(":", "/")}`;
}

/**
 * Where a multipart upload accumulates.
 *
 * A multipart upload must name its key before the first part is written, and a
 * chunked push only reveals its digest in the closing PUT. R2 has no rename, so
 * the finished object keeps this key and the metadata store maps digest to key.
 */
export function stagingKey(sessionId: string): string {
  return `blobs/staged/${sessionId}`;
}

/** Sub-part-sized leftovers parked between chunks of an upload. */
export function carryKey(sessionId: string): string {
  return `uploads/${sessionId}/carry`;
}

/** Manifests are addressed separately: they are never served from the blobs endpoint. */
export function manifestKey(digest: string): string {
  return `manifests/${digest.replace(":", "/")}`;
}

export const STAGING_PREFIX = "blobs/staged/";
export const MANIFEST_PREFIX = "manifests/";
export const UPLOAD_PREFIX = "uploads/";
