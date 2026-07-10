/**
 * The interfaces the registry needs from its environment.
 *
 * Everything below is deliberately free of Cloudflare types: the handlers are
 * written against these ports, the Worker supplies R2/D1/Durable Object
 * implementations, and the tests supply in-memory ones. The split is what makes
 * the distribution-spec logic testable without a network or a bucket.
 */

/** A blob's identity and where its bytes actually live. */
export interface BlobRecord {
  readonly digest: string;
  readonly size: number;
  /** Opaque object-store key. Not derivable from the digest: see BlobStore.stagingKey. */
  readonly storageKey: string;
}

export interface ManifestRecord {
  readonly digest: string;
  readonly mediaType: string;
  readonly size: number;
  readonly artifactType: string | null;
  readonly subjectDigest: string | null;
  readonly annotations: Readonly<Record<string, string>> | null;
}

/** A row of a referrers listing, before it is rendered as a descriptor. */
export interface ReferrerRecord {
  readonly digest: string;
  readonly mediaType: string;
  readonly size: number;
  readonly artifactType: string | null;
  readonly annotations: Readonly<Record<string, string>> | null;
}

export interface TagPage {
  readonly tags: readonly string[];
  /** True when tags exist beyond this page, which mandates a `Link` header. */
  readonly hasMore: boolean;
}

export interface MetadataStore {
  repositoryExists(repository: string): Promise<boolean>;
  ensureRepository(repository: string): Promise<void>;

  /** Looks a blob up globally, ignoring which repositories link to it. */
  getBlob(digest: string): Promise<BlobRecord | null>;
  /**
   * Repositories that link a blob, for authorising an automatic cross-mount.
   * Bounded by `limit`, since only one readable source is needed.
   */
  repositoriesLinkingBlob(digest: string, limit: number): Promise<string[]>;
  /** Looks a blob up within one repository. A blob not linked here is a 404 here. */
  getLinkedBlob(repository: string, digest: string): Promise<BlobRecord | null>;
  /**
   * Records blob content and links it into `repository` atomically,
   * deduplicating on digest. Returns the record that won: if another upload
   * already stored these bytes, the returned `storageKey` differs from the one
   * passed in and the caller must delete its own object.
   *
   * Registering and linking must commit together. Were they two transactions,
   * garbage collection could observe the blob between them - registered, not
   * yet linked, and older than its grace period - and reclaim content the
   * repository is about to depend on.
   */
  registerAndLinkBlob(repository: string, record: BlobRecord): Promise<BlobRecord>;
  /**
   * Links an existing blob into a repository, as a cross-mount does. Returns
   * false when no such blob exists, which includes the case where garbage
   * collection removed it while the mount was being authorised.
   */
  linkBlob(repository: string, digest: string): Promise<boolean>;
  /** Returns false when the repository held no link to the blob. */
  unlinkBlob(repository: string, digest: string): Promise<boolean>;
  /** Returns the subset of `digests` that this repository does not link. */
  missingLinkedBlobs(repository: string, digests: readonly string[]): Promise<string[]>;

  getManifest(repository: string, digest: string): Promise<ManifestRecord | null>;
  /** Returns the subset of `digests` that are not manifests in this repository. */
  missingManifests(repository: string, digests: readonly string[]): Promise<string[]>;
  resolveTag(repository: string, tag: string): Promise<string | null>;
  putManifest(
    repository: string,
    record: ManifestRecord,
    references: { readonly blobs: readonly string[]; readonly manifests: readonly string[] },
  ): Promise<void>;
  tagManifest(repository: string, tag: string, digest: string): Promise<void>;
  /** Deletes the manifest and every tag pointing at it. False when absent. */
  deleteManifest(repository: string, digest: string): Promise<boolean>;
  deleteTag(repository: string, tag: string): Promise<boolean>;
  listTags(repository: string, options: { limit: number; last?: string }): Promise<TagPage>;
  listReferrers(repository: string, subjectDigest: string): Promise<ReferrerRecord[]>;
}

export interface BlobBody {
  readonly body: ReadableStream<Uint8Array>;
  /** Bytes in `body`, which is the range length when a range was requested. */
  readonly size: number;
  /** Size of the whole object. */
  readonly totalSize: number;
}

/**
 * The stored bytes did not match the checksum or length the client promised.
 * Distinct from any other `put` failure so that a broken object store surfaces
 * as a 500 rather than being blamed on the client as a 400.
 */
export class ContentIntegrityError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ContentIntegrityError";
  }
}

export interface ContentStore {
  get(storageKey: string, range?: { offset: number; length: number }): Promise<BlobBody | null>;
  /**
   * Stores content and verifies it hashes to `sha256Hex`, rejecting otherwise.
   * Implementations should push the check down to the object store when they can.
   */
  put(
    storageKey: string,
    body: ReadableStream<Uint8Array> | Uint8Array,
    size: number,
    sha256Hex: string,
  ): Promise<void>;
  delete(storageKey: string): Promise<void>;
  /** Content-addressed key, used when the digest is known before the bytes arrive. */
  blobKey(digest: string): string;
  /**
   * Manifests live in their own key space. A manifest is not reachable through
   * the blobs endpoint, and sharing a namespace would let a blob upload
   * overwrite a manifest that happened to hash the same.
   */
  manifestKey(digest: string): string;
}

export interface UploadStatus {
  readonly id: string;
  readonly repository: string;
  /** Bytes accepted so far; equivalently, the offset the next chunk must start at. */
  readonly offset: number;
}

export interface ChunkOptions {
  /** Byte range this chunk claims to occupy, inclusive on both ends. */
  readonly contentRange?: { readonly start: number; readonly end: number };
  readonly contentLength?: number;
}

export interface UploadStore {
  create(repository: string): Promise<string>;
  status(repository: string, id: string): Promise<UploadStatus | null>;
  /** Appends a chunk. Throws `rangeNotSatisfiable` when the chunk is out of order. */
  append(
    repository: string,
    id: string,
    body: ReadableStream<Uint8Array>,
    options: ChunkOptions,
  ): Promise<UploadStatus>;
  /**
   * Appends any final chunk, verifies the accumulated content hashes to
   * `digest`, and materialises the blob. Does not register or link it.
   */
  complete(
    repository: string,
    id: string,
    digest: string,
    body: ReadableStream<Uint8Array> | null,
    options: ChunkOptions,
  ): Promise<BlobRecord>;
  cancel(repository: string, id: string): Promise<void>;
}

export type Action = "pull" | "push" | "delete";

/**
 * Throws `unauthorized` (401) or `denied` (403) when the caller may not perform
 * `action` on `repository`. Resolving means the request is allowed.
 *
 * An empty `repository` denotes registry scope, used by the `GET /v2/` probe
 * that clients issue to discover whether they need to authenticate at all.
 */
export type Authorize = (repository: string, action: Action) => Promise<void>;

export interface RegistryConfig {
  /** Rejects manifests larger than this with 413. */
  readonly maxManifestSize: number;
  /** Reject a manifest whose config or layers are absent from the repository. */
  readonly validateBlobReferences: boolean;
  /** Reject an index whose child manifests are absent. Off by default: clients push children in any order. */
  readonly validateManifestReferences: boolean;
  /** Serve `POST /v2/<name>/blobs/uploads/?mount=<digest>` without a `from` parameter. */
  readonly automaticCrossMount: boolean;
  /** Page size used when a tag listing request omits `n`. */
  readonly defaultTagPageSize: number;
  readonly enableDeletes: boolean;
}

export const DEFAULT_CONFIG: RegistryConfig = {
  maxManifestSize: 4 * 1024 * 1024,
  validateBlobReferences: true,
  validateManifestReferences: false,
  automaticCrossMount: true,
  defaultTagPageSize: 1000,
  enableDeletes: true,
};

/**
 * Rules the distribution API must obey but cannot itself know.
 *
 * Storage quotas, signature requirements - anything that depends on who owns a
 * repository rather than on what the spec says - is decided here. Each hook
 * throws an `OciError` to refuse, and returns to permit. The core calls them at
 * the exact points where a refusal is still free: before bytes are charged to
 * anyone, before a tag moves, before a manifest is handed out.
 */
export interface RegistryPolicy {
  /** Before a blob is linked into a repository, whether uploaded or cross-mounted. */
  beforeBlobLink(repository: string, blob: { digest: string; size: number }): Promise<void>;
  /** Before a manifest is stored. `tag` is null when it is pushed by digest alone. */
  beforeManifestPush(repository: string, record: ManifestRecord, tag: string | null): Promise<void>;
  /** Before a manifest's bytes are served. */
  beforeManifestPull(repository: string, record: ManifestRecord): Promise<void>;
  /** Before a tag is removed. The manifest it names survives. */
  beforeTagDelete(repository: string, tag: string): Promise<void>;
  /** Before a manifest is removed, taking every tag that names it with it. */
  beforeManifestDelete(repository: string, digest: string): Promise<void>;
}

/** A policy that refuses nothing. What a registry with no projects behind it does. */
export const PERMISSIVE_POLICY: RegistryPolicy = {
  async beforeBlobLink() {},
  async beforeManifestPush() {},
  async beforeManifestPull() {},
  async beforeTagDelete() {},
  async beforeManifestDelete() {},
};

/**
 * Told about what happened, never asked whether it may. Handlers must not await
 * these: an adapter records statistics and fans out notifications, and neither
 * belongs on the critical path of a `docker pull`.
 */
export interface RegistryEvents {
  blobPushed(repository: string, blob: { digest: string; size: number }): void;
  manifestPushed(repository: string, record: ManifestRecord, tag: string | null): void;
  manifestPulled(repository: string, record: ManifestRecord, reference: string): void;
  manifestDeleted(repository: string, digest: string): void;
  tagDeleted(repository: string, tag: string): void;
}

export const NO_EVENTS: RegistryEvents = {
  blobPushed() {},
  manifestPushed() {},
  manifestPulled() {},
  manifestDeleted() {},
  tagDeleted() {},
};

export interface RegistryContext {
  readonly metadata: MetadataStore;
  readonly content: ContentStore;
  readonly uploads: UploadStore;
  readonly config: RegistryConfig;
  readonly authorize: Authorize;
  /** Defaults to `PERMISSIVE_POLICY`. */
  readonly policy?: RegistryPolicy;
  /** Defaults to `NO_EVENTS`. */
  readonly events?: RegistryEvents;
}

export function policyOf(ctx: RegistryContext): RegistryPolicy {
  return ctx.policy ?? PERMISSIVE_POLICY;
}

export function eventsOf(ctx: RegistryContext): RegistryEvents {
  return ctx.events ?? NO_EVENTS;
}
