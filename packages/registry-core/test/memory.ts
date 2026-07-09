/**
 * In-memory implementations of every port.
 *
 * These exist so the distribution-spec behaviour can be exercised end to end -
 * routing, status codes, headers, upload state machine - without R2, D1, or a
 * Durable Object anywhere in the picture. The Worker's adapters are then thin
 * enough that the conformance suite is the only thing that needs to run against
 * real infrastructure.
 */

import { Sha256, blobUploadUnknown, sha256Hex } from "@registry/oci";
import {
  ContentIntegrityError,
  DEFAULT_CONFIG,
  type BlobBody,
  type BlobRecord,
  type ChunkOptions,
  type ContentStore,
  type ManifestRecord,
  type MetadataStore,
  type ReferrerRecord,
  type RegistryConfig,
  type RegistryContext,
  type TagPage,
  type UploadStatus,
  type UploadStore,
} from "../src/ports.js";
import {
  UploadSession,
  createSessionState,
  type SessionBackend,
  type SessionState,
  type UploadedPart,
} from "../src/upload-session.js";
import { digestHex } from "../src/validate.js";

export class MemoryContentStore implements ContentStore {
  readonly objects = new Map<string, Uint8Array>();

  blobKey(digest: string): string {
    return `blobs/${digest.replace(":", "/")}`;
  }

  manifestKey(digest: string): string {
    return `manifests/${digest.replace(":", "/")}`;
  }

  async get(storageKey: string, range?: { offset: number; length: number }): Promise<BlobBody | null> {
    const object = this.objects.get(storageKey);
    if (object === undefined) return null;
    const slice = range === undefined ? object : object.subarray(range.offset, range.offset + range.length);
    return {
      body: new Response(slice as BodyInit).body as ReadableStream<Uint8Array>,
      size: slice.length,
      totalSize: object.length,
    };
  }

  async put(
    storageKey: string,
    body: ReadableStream<Uint8Array> | Uint8Array,
    size: number,
    sha256: string,
  ): Promise<void> {
    const bytes = body instanceof Uint8Array ? body : new Uint8Array(await new Response(body).arrayBuffer());
    if (bytes.length !== size) throw new ContentIntegrityError(`expected ${size} bytes, got ${bytes.length}`);
    if (sha256Hex(bytes) !== sha256) throw new ContentIntegrityError("checksum mismatch");
    this.objects.set(storageKey, bytes);
  }

  async delete(storageKey: string): Promise<void> {
    this.objects.delete(storageKey);
  }
}

interface StoredManifest extends ManifestRecord {
  readonly blobs: readonly string[];
  readonly manifests: readonly string[];
}

export class MemoryMetadataStore implements MetadataStore {
  private readonly repositories = new Set<string>();
  private readonly blobs = new Map<string, BlobRecord>();
  private readonly blobLinks = new Map<string, Set<string>>();
  private readonly manifests = new Map<string, Map<string, StoredManifest>>();
  private readonly tags = new Map<string, Map<string, string>>();

  async repositoryExists(repository: string): Promise<boolean> {
    return this.repositories.has(repository);
  }

  async ensureRepository(repository: string): Promise<void> {
    this.repositories.add(repository);
  }

  async getBlob(digest: string): Promise<BlobRecord | null> {
    return this.blobs.get(digest) ?? null;
  }

  async repositoriesLinkingBlob(digest: string, limit: number): Promise<string[]> {
    const linking: string[] = [];
    for (const [repository, digests] of this.blobLinks) {
      if (digests.has(digest)) linking.push(repository);
    }
    return linking.toSorted().slice(0, limit);
  }

  async getLinkedBlob(repository: string, digest: string): Promise<BlobRecord | null> {
    if (!this.blobLinks.get(repository)?.has(digest)) return null;
    return this.blobs.get(digest) ?? null;
  }

  async registerAndLinkBlob(repository: string, record: BlobRecord): Promise<BlobRecord> {
    const existing = this.blobs.get(record.digest);
    const winner = existing ?? record;
    this.blobs.set(record.digest, winner);
    this.addLink(repository, record.digest);
    return winner;
  }

  async linkBlob(repository: string, digest: string): Promise<boolean> {
    if (!this.blobs.has(digest)) return false;
    this.addLink(repository, digest);
    return true;
  }

  private addLink(repository: string, digest: string): void {
    this.repositories.add(repository);
    let links = this.blobLinks.get(repository);
    if (links === undefined) {
      links = new Set();
      this.blobLinks.set(repository, links);
    }
    links.add(digest);
  }

  async unlinkBlob(repository: string, digest: string): Promise<boolean> {
    return this.blobLinks.get(repository)?.delete(digest) ?? false;
  }

  async missingLinkedBlobs(repository: string, digests: readonly string[]): Promise<string[]> {
    const links = this.blobLinks.get(repository) ?? new Set<string>();
    return digests.filter((digest) => !links.has(digest));
  }

  async getManifest(repository: string, digest: string): Promise<ManifestRecord | null> {
    return this.manifests.get(repository)?.get(digest) ?? null;
  }

  async missingManifests(repository: string, digests: readonly string[]): Promise<string[]> {
    const stored = this.manifests.get(repository);
    return digests.filter((digest) => stored?.get(digest) === undefined);
  }

  async resolveTag(repository: string, tag: string): Promise<string | null> {
    return this.tags.get(repository)?.get(tag) ?? null;
  }

  async putManifest(
    repository: string,
    record: ManifestRecord,
    references: { readonly blobs: readonly string[]; readonly manifests: readonly string[] },
  ): Promise<void> {
    this.repositories.add(repository);
    let stored = this.manifests.get(repository);
    if (stored === undefined) {
      stored = new Map();
      this.manifests.set(repository, stored);
    }
    stored.set(record.digest, { ...record, blobs: references.blobs, manifests: references.manifests });
  }

  async tagManifest(repository: string, tag: string, digest: string): Promise<void> {
    let tags = this.tags.get(repository);
    if (tags === undefined) {
      tags = new Map();
      this.tags.set(repository, tags);
    }
    tags.set(tag, digest);
  }

  async deleteManifest(repository: string, digest: string): Promise<boolean> {
    const stored = this.manifests.get(repository);
    if (stored?.delete(digest) !== true) return false;
    const tags = this.tags.get(repository);
    if (tags !== undefined) {
      for (const [tag, target] of tags) if (target === digest) tags.delete(tag);
    }
    return true;
  }

  async deleteTag(repository: string, tag: string): Promise<boolean> {
    return this.tags.get(repository)?.delete(tag) ?? false;
  }

  async listTags(repository: string, options: { limit: number; last?: string }): Promise<TagPage> {
    const all = [...(this.tags.get(repository)?.keys() ?? [])].toSorted();
    const start = options.last === undefined ? 0 : all.findIndex((tag) => tag > options.last!);
    const from = start === -1 ? all.length : start;
    const tags = all.slice(from, from + options.limit);
    return { tags, hasMore: from + options.limit < all.length };
  }

  async listReferrers(repository: string, subjectDigest: string): Promise<ReferrerRecord[]> {
    const stored = this.manifests.get(repository);
    if (stored === undefined) return [];
    return [...stored.values()].filter((manifest) => manifest.subjectDigest === subjectDigest);
  }
}

class MemorySessionBackend implements SessionBackend {
  constructor(
    private readonly content: MemoryContentStore,
    private readonly id: string,
    private readonly multiparts: Map<string, Map<number, Uint8Array>>,
  ) {}

  private get carryKey(): string {
    return `uploads/${this.id}/carry`;
  }

  async readCarry(): Promise<Uint8Array> {
    return this.content.objects.get(this.carryKey) ?? new Uint8Array(0);
  }

  async writeCarry(bytes: Uint8Array): Promise<void> {
    this.content.objects.set(this.carryKey, bytes.slice());
  }

  async deleteCarry(): Promise<void> {
    this.content.objects.delete(this.carryKey);
  }

  async createMultipart(key: string): Promise<string> {
    const uploadId = `mp-${this.id}`;
    this.multiparts.set(uploadId, new Map());
    void key;
    return uploadId;
  }

  async uploadPart(
    _key: string,
    uploadId: string,
    partNumber: number,
    bytes: Uint8Array,
  ): Promise<UploadedPart> {
    const parts = this.multiparts.get(uploadId);
    if (parts === undefined) throw new Error(`unknown multipart upload ${uploadId}`);
    parts.set(partNumber, bytes.slice());
    return { partNumber, etag: `etag-${partNumber}` };
  }

  async completeMultipart(key: string, uploadId: string, parts: readonly UploadedPart[]): Promise<void> {
    const stored = this.multiparts.get(uploadId);
    if (stored === undefined) throw new Error(`unknown multipart upload ${uploadId}`);

    // Mirror R2's rule: every part but the last must be identical in size.
    const sizes = parts.map((part) => stored.get(part.partNumber)?.length ?? -1);
    for (let i = 0; i < sizes.length - 1; i++) {
      if (sizes[i] !== sizes[0]) throw new Error("R2 requires uniform non-trailing part sizes");
    }

    const total = sizes.reduce((sum, size) => sum + size, 0);
    const object = new Uint8Array(total);
    let offset = 0;
    for (const part of parts) {
      const bytes = stored.get(part.partNumber)!;
      object.set(bytes, offset);
      offset += bytes.length;
    }
    this.content.objects.set(key, object);
    this.multiparts.delete(uploadId);
  }

  async abortMultipart(_key: string, uploadId: string): Promise<void> {
    this.multiparts.delete(uploadId);
  }

  async putObject(
    key: string,
    body: ReadableStream<Uint8Array> | Uint8Array,
    size: number,
    sha256: string,
  ): Promise<void> {
    await this.content.put(key, body, size, sha256);
  }

  async deleteObject(key: string): Promise<void> {
    await this.content.delete(key);
  }

  blobKey(digest: string): string {
    return this.content.blobKey(digest);
  }

  stagingKey(): string {
    return `blobs/staged/${this.id}`;
  }
}

/** Mirrors the Durable Object: owns session state, delegates to {@link UploadSession}. */
export class MemoryUploadStore implements UploadStore {
  private readonly sessions = new Map<string, SessionState>();
  private readonly multiparts = new Map<string, Map<number, Uint8Array>>();
  private counter = 0;

  constructor(
    private readonly content: MemoryContentStore,
    private readonly partSize?: number,
  ) {}

  async create(repository: string): Promise<string> {
    const id = `upload-${++this.counter}`;
    this.sessions.set(id, createSessionState(repository));
    return id;
  }

  async status(repository: string, id: string): Promise<UploadStatus | null> {
    const state = this.load(repository, id, false);
    return state === null ? null : { id, repository, offset: state.offset };
  }

  async append(
    repository: string,
    id: string,
    body: ReadableStream<Uint8Array>,
    options: ChunkOptions,
  ): Promise<UploadStatus> {
    const state = this.load(repository, id, true)!;
    const session = new UploadSession(
      new MemorySessionBackend(this.content, id, this.multiparts),
      state,
      this.partSize,
    );
    await session.append(body, options);
    this.sessions.set(id, session.state);
    return { id, repository, offset: session.offset };
  }

  async complete(
    repository: string,
    id: string,
    digest: string,
    body: ReadableStream<Uint8Array> | null,
    options: ChunkOptions,
  ): Promise<BlobRecord> {
    const state = this.load(repository, id, true)!;
    const session = new UploadSession(
      new MemorySessionBackend(this.content, id, this.multiparts),
      state,
      this.partSize,
    );
    try {
      const record = await session.complete(digest, body, options);
      this.sessions.delete(id);
      return record;
    } catch (error) {
      this.sessions.delete(id);
      throw error;
    }
  }

  async cancel(repository: string, id: string): Promise<void> {
    const state = this.load(repository, id, false);
    if (state === null) return;
    const session = new UploadSession(
      new MemorySessionBackend(this.content, id, this.multiparts),
      state,
      this.partSize,
    );
    await session.discard();
    this.sessions.delete(id);
  }

  private load(repository: string, id: string, required: boolean): SessionState | null {
    const state = this.sessions.get(id);
    if (state === undefined || state.repository !== repository) {
      if (required) throw blobUploadUnknown();
      return null;
    }
    return state;
  }
}

export interface TestRegistry extends RegistryContext {
  readonly metadata: MemoryMetadataStore;
  readonly content: MemoryContentStore;
  readonly uploads: MemoryUploadStore;
}

export function createTestRegistry(
  overrides: Partial<RegistryConfig> = {},
  options: { partSize?: number; authorize?: RegistryContext["authorize"] } = {},
): TestRegistry {
  const content = new MemoryContentStore();
  return {
    metadata: new MemoryMetadataStore(),
    content,
    uploads: new MemoryUploadStore(content, options.partSize),
    config: { ...DEFAULT_CONFIG, ...overrides },
    authorize: options.authorize ?? (async () => undefined),
  };
}

/** Sanity check used by the tests: the resumable hash agrees with a one-shot hash. */
export function digestOfBytes(bytes: Uint8Array): string {
  return `sha256:${new Sha256().update(bytes).digestHex()}`;
}

export { digestHex };
