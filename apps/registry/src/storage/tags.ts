import { D1MetadataStore } from "./metadata.js";

/**
 * What the tag table says, for the policy hooks that need to ask.
 *
 * Narrow on purpose. `ProjectPolicy` needs two questions answered to enforce
 * immutable tags, and giving it the whole `MetadataStore` would give it the
 * power to write as well.
 */
export class TagIndex {
  private readonly metadata: D1MetadataStore;

  constructor(private readonly db: D1Database) {
    this.metadata = new D1MetadataStore(db);
  }

  /**
   * The digest a tag currently names, or null when the tag does not exist. The
   * resolution query has one home, in the metadata store; this narrow index
   * delegates to it rather than restating it.
   */
  async resolveTag(repository: string, tag: string): Promise<string | null> {
    return this.metadata.resolveTag(repository, tag);
  }

  /**
   * Whether any tag in the repository names this manifest.
   *
   * Deleting a manifest by digest takes its tags with it, so an immutable
   * project must refuse that. An untagged manifest - a signature, an SBOM, a
   * superseded image - has no tag to protect and may still be deleted.
   */
  async isTagged(repository: string, digest: string): Promise<boolean> {
    const row = await this.db
      .prepare("SELECT 1 FROM tags WHERE repository = ? AND manifest_digest = ? LIMIT 1")
      .bind(repository, digest)
      .first();
    return row !== null;
  }

  /**
   * Whether the repository holds any tag at all.
   *
   * Deleting a repository takes its tags with it, so an immutable project must
   * refuse that too. An empty repository has nothing to protect.
   */
  async hasAnyTag(repository: string): Promise<boolean> {
    const row = await this.db
      .prepare("SELECT 1 FROM tags WHERE repository = ? LIMIT 1")
      .bind(repository)
      .first();
    return row !== null;
  }
}
