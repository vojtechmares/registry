import type { BlobRecord, ContentStore, MetadataStore } from "./ports.js";

/**
 * Commits a freshly written blob: registers it and links it into the repository
 * in one transaction, then drops the object this write produced if identical
 * bytes were already stored under a different key.
 *
 * Deduplication happens at the register step. `registerAndLinkBlob` returns the
 * record that survived, which is the incumbent when a concurrent write - or a
 * prior chunked upload keeping its staging key - already holds the same bytes.
 * When the surviving key differs from the one just written, our object is the
 * loser and is deleted: losing the race costs one wasted write, never a corrupt
 * pointer and never a leaked object.
 *
 * Every write path - the upload handler and replication's local mirror - goes
 * through here, so no caller can register a blob and forget the loser cleanup.
 * Returns the surviving record.
 */
export async function commitBlob(
  metadata: MetadataStore,
  content: ContentStore,
  repository: string,
  record: BlobRecord,
): Promise<BlobRecord> {
  const stored = await metadata.registerAndLinkBlob(repository, record);
  if (stored.storageKey !== record.storageKey) {
    await content.delete(record.storageKey);
  }
  return stored;
}
