/**
 * The registry operations a copy needs, and nothing more.
 *
 * Both ends of a replication implement this: the far end over HTTP, and this
 * registry straight against its own stores. That is what lets one `copyArtifact`
 * serve both directions - a rule that pulls from Docker Hub and a rule that
 * pushes to a downstream mirror run the same code, with the endpoints swapped.
 */

export interface ManifestBytes {
  readonly bytes: Uint8Array;
  readonly mediaType: string;
  readonly digest: string;
}

export interface BlobStream {
  readonly body: ReadableStream<Uint8Array>;
  readonly size: number;
}

export interface RegistryClient {
  /** A short name for logs and error messages. */
  readonly name: string;

  /** `reference` is a tag or a digest. Null when it does not exist. */
  getManifest(repository: string, reference: string): Promise<ManifestBytes | null>;
  putManifest(repository: string, reference: string, manifest: ManifestBytes): Promise<void>;

  hasBlob(repository: string, digest: string): Promise<boolean>;
  getBlob(repository: string, digest: string): Promise<BlobStream | null>;
  putBlob(repository: string, digest: string, blob: BlobStream): Promise<void>;

  listTags(repository: string): Promise<string[]>;
}
