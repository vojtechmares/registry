import { digestOfAsync, parseManifest, referencedContent, referrerArtifactType } from "@registry/oci";
import type { BlobStream, ManifestBytes, RegistryClient } from "@registry/replication";
import type { ContentStore, ManifestRecord, MetadataStore, RegistryPolicy } from "@registry/registry-core";

/**
 * This registry, seen through the same interface as any other.
 *
 * A pull rule copies into here; a push rule copies out of here. Talking to
 * ourselves over HTTP would work and would also mean minting a credential for
 * the registry to present to itself, so the stores are used directly - through
 * the very policy hooks a `docker push` goes through. A replicated image is
 * charged to the project's quota and refused when the project is full, exactly
 * as a hand-pushed one would be.
 */
export class LocalRegistry implements RegistryClient {
  readonly name = "this registry";

  constructor(
    private readonly metadata: MetadataStore,
    private readonly content: ContentStore,
    private readonly policy: RegistryPolicy,
  ) {}

  async getManifest(repository: string, reference: string): Promise<ManifestBytes | null> {
    const digest = reference.startsWith("sha256:")
      ? reference
      : await this.metadata.resolveTag(repository, reference);
    if (digest === null) return null;

    const record = await this.metadata.getManifest(repository, digest);
    if (record === null) return null;

    const body = await this.content.get(this.content.manifestKey(digest));
    if (body === null) return null;

    const bytes = new Uint8Array(await new Response(body.body).arrayBuffer());
    return { bytes, mediaType: record.mediaType, digest };
  }

  async putManifest(repository: string, reference: string, manifest: ManifestBytes): Promise<void> {
    const parsed = parseManifest(manifest.bytes, manifest.mediaType);
    const digest = await digestOfAsync(manifest.bytes);
    if (digest !== manifest.digest) {
      throw new Error(`manifest digest ${manifest.digest} does not match its bytes`);
    }

    const artifactType = referrerArtifactType(parsed);
    const record: ManifestRecord = {
      digest,
      mediaType: parsed.mediaType,
      size: manifest.bytes.length,
      artifactType: artifactType ?? null,
      subjectDigest: parsed.subject?.digest ?? null,
      annotations: parsed.annotations ?? null,
    };

    const tag = reference.startsWith("sha256:") ? null : reference;
    await this.policy.beforeManifestPush(repository, record, tag);

    await this.metadata.ensureRepository(repository);
    await this.content.put(
      this.content.manifestKey(digest),
      manifest.bytes,
      manifest.bytes.length,
      digest.slice("sha256:".length),
    );
    await this.metadata.putManifest(repository, record, referencedContent(parsed));
    if (tag !== null) await this.metadata.tagManifest(repository, tag, digest);
  }

  async hasBlob(repository: string, digest: string): Promise<boolean> {
    return (await this.metadata.getLinkedBlob(repository, digest)) !== null;
  }

  async getBlob(repository: string, digest: string): Promise<BlobStream | null> {
    const record = await this.metadata.getLinkedBlob(repository, digest);
    if (record === null) return null;

    const body = await this.content.get(record.storageKey);
    if (body === null) return null;
    return { body: body.body, size: record.size };
  }

  /**
   * Writes a blob and links it into the repository.
   *
   * A size the source would not report has to be resolved before R2 will take
   * the bytes, which means buffering them. The remote client reads
   * `Content-Length` and so almost never leaves us here.
   */
  async putBlob(repository: string, digest: string, blob: BlobStream): Promise<void> {
    let body: ReadableStream<Uint8Array> | Uint8Array = blob.body;
    let size = blob.size;

    if (size < 0) {
      const buffered = new Uint8Array(await new Response(blob.body).arrayBuffer());
      body = buffered;
      size = buffered.length;
    }

    await this.policy.beforeBlobLink(repository, { digest, size });
    await this.metadata.ensureRepository(repository);

    const key = this.content.blobKey(digest);
    await this.content.put(key, body, size, digest.slice("sha256:".length));
    await this.metadata.registerAndLinkBlob(repository, { digest, size, storageKey: key });
  }

  async listTags(repository: string): Promise<string[]> {
    const page = await this.metadata.listTags(repository, { limit: 1000 });
    return [...page.tags];
  }
}
