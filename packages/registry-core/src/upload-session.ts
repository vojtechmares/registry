import { Sha256, digestEquals, digestInvalid, sizeInvalid } from "@registry/oci";
import { rangeNotSatisfiable } from "./http.js";
import { ContentIntegrityError } from "./ports.js";
import type { BlobRecord, ChunkOptions } from "./ports.js";
import { digestHex } from "./validate.js";

/**
 * Resumable blob uploads.
 *
 * Two constraints of the object store shape everything here.
 *
 * R2 multipart uploads require every part except the last to be *the same size*
 * and at least 5 MiB, but a client may PATCH chunks of any size it likes. So
 * bytes are accumulated into a fixed-size window and a part is flushed only
 * once exactly `partSize` bytes are ready. The leftover - always smaller than a
 * part - is parked in a "carry" object between requests. Uniform part sizes then
 * hold by construction.
 *
 * And the digest can only be checked once the last byte arrives, which may be
 * several HTTP requests after the first. Web Crypto cannot hash incrementally
 * across requests, so the SHA-256 mid-state rides along in the session state.
 *
 * A session that never exceeds one part never starts a multipart upload at all:
 * it finishes with a single `put`, and the object store verifies the checksum
 * for us.
 */

/** R2's minimum non-trailing part size. */
export const PART_SIZE = 5 * 1024 * 1024;

/** R2's cap. With a 5 MiB part size this bounds a blob at just under 49 GiB. */
export const MAX_PARTS = 10_000;

export interface UploadedPart {
  readonly partNumber: number;
  readonly etag: string;
}

export interface MultipartState {
  readonly uploadId: string;
  readonly key: string;
  readonly parts: UploadedPart[];
}

export interface SessionState {
  readonly repository: string;
  /** Bytes accepted, and therefore the offset the next chunk must start at. */
  offset: number;
  /** Serialised SHA-256 mid-state covering the first `offset` bytes. */
  hash: Uint8Array;
  /** Bytes parked in the carry object, always `< partSize`. */
  carrySize: number;
  multipart: MultipartState | null;
}

export interface SessionBackend {
  readCarry(): Promise<Uint8Array>;
  writeCarry(bytes: Uint8Array): Promise<void>;
  deleteCarry(): Promise<void>;

  createMultipart(key: string): Promise<string>;
  uploadPart(key: string, uploadId: string, partNumber: number, bytes: Uint8Array): Promise<UploadedPart>;
  completeMultipart(key: string, uploadId: string, parts: readonly UploadedPart[]): Promise<void>;
  abortMultipart(key: string, uploadId: string): Promise<void>;

  putObject(
    key: string,
    body: ReadableStream<Uint8Array> | Uint8Array,
    size: number,
    sha256Hex: string,
  ): Promise<void>;
  deleteObject(key: string): Promise<void>;

  /** Content-addressed key, usable once the digest is known. */
  blobKey(digest: string): string;
  /** Where a multipart upload accumulates while its digest is still unknown. */
  stagingKey(): string;
}

export function createSessionState(repository: string): SessionState {
  return {
    repository,
    offset: 0,
    hash: new Sha256().serialize(),
    carrySize: 0,
    multipart: null,
  };
}

export class UploadSession {
  constructor(
    private readonly backend: SessionBackend,
    readonly state: SessionState,
    private readonly partSize: number = PART_SIZE,
  ) {}

  get offset(): number {
    return this.state.offset;
  }

  /**
   * Appends a chunk. Mutates `state` only on success, so a caller that persists
   * `state` afterwards can safely retry a failed chunk: any parts already
   * uploaded are re-uploaded under the same part numbers and overwritten.
   */
  async append(body: ReadableStream<Uint8Array>, options: ChunkOptions, enforceLength = true): Promise<void> {
    const { contentRange } = options;
    if (contentRange !== undefined && contentRange.start !== this.state.offset) {
      throw rangeNotSatisfiable(this.state.offset);
    }

    const hash = Sha256.deserialize(this.state.hash);
    const parts = [...(this.state.multipart?.parts ?? [])];
    const priorMultipart = this.state.multipart;
    let multipart = priorMultipart;

    // A window exactly one part wide. Bytes land here; a part is flushed the
    // instant it fills, so the carry left at the end is always sub-part-sized.
    const window = new Uint8Array(this.partSize);
    let windowLength = 0;
    if (this.state.carrySize > 0) {
      const carry = await this.backend.readCarry();
      if (carry.length !== this.state.carrySize) {
        throw new ContentIntegrityError("upload carry object does not match the recorded size");
      }
      window.set(carry);
      windowLength = carry.length;
    }

    const flush = async (): Promise<void> => {
      if (parts.length >= MAX_PARTS) {
        throw sizeInvalid(`blob exceeds the maximum of ${MAX_PARTS} parts`);
      }
      if (multipart === null) {
        const key = this.backend.stagingKey();
        multipart = { uploadId: await this.backend.createMultipart(key), key, parts };
      }
      parts.push(await this.backend.uploadPart(multipart.key, multipart.uploadId, parts.length + 1, window));
      windowLength = 0;
    };

    let received = 0;
    const reader = body.getReader();
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        if (value.length === 0) continue;

        hash.update(value);
        received += value.length;

        let offset = 0;
        while (offset < value.length) {
          const take = Math.min(this.partSize - windowLength, value.length - offset);
          window.set(value.subarray(offset, offset + take), windowLength);
          windowLength += take;
          offset += take;
          if (windowLength === this.partSize) await flush();
        }
      }

      if (enforceLength && options.contentLength !== undefined && received !== options.contentLength) {
        throw sizeInvalid(`expected ${options.contentLength} bytes, received ${received}`);
      }
      if (contentRange !== undefined && received !== contentRange.end - contentRange.start + 1) {
        throw sizeInvalid("Content-Range does not describe the bytes received");
      }

      if (windowLength > 0) {
        await this.backend.writeCarry(window.subarray(0, windowLength));
      } else if (this.state.carrySize > 0) {
        await this.backend.deleteCarry();
      }
    } catch (error) {
      // A multipart created during *this* call has no committed parts to
      // preserve, so abort it rather than leave it orphaned. State is untouched,
      // so the client's retry resumes cleanly - it will open a fresh upload.
      // A multipart carried in from a prior successful call is left intact: its
      // parts are keyed by number, so the retry overwrites them idempotently.
      if (multipart !== null && multipart !== priorMultipart) {
        await this.backend.abortMultipart(multipart.key, multipart.uploadId).catch(() => undefined);
      }
      throw error;
    } finally {
      reader.releaseLock();
    }

    this.state.offset += received;
    this.state.carrySize = windowLength;
    this.state.hash = hash.serialize();
    this.state.multipart = multipart === null ? null : { ...multipart, parts };
  }

  /**
   * Consumes any final chunk, verifies the digest, and materialises the blob.
   *
   * Verification happens before the multipart upload is completed, so content
   * that fails its checksum is never observable at the blob's key.
   */
  async complete(
    digest: string,
    body: ReadableStream<Uint8Array> | null,
    options: ChunkOptions,
  ): Promise<BlobRecord> {
    // Fast path: a whole blob arriving in one request on an untouched session.
    // The digest is already known, so the object store can verify it for us and
    // we never hash a byte in JavaScript.
    if (
      this.state.offset === 0 &&
      this.state.multipart === null &&
      this.state.carrySize === 0 &&
      body !== null &&
      options.contentRange === undefined &&
      options.contentLength !== undefined &&
      options.contentLength > 0
    ) {
      const key = this.backend.blobKey(digest);
      try {
        await this.backend.putObject(key, body, options.contentLength, digestHex(digest));
      } catch (error) {
        if (!(error instanceof ContentIntegrityError)) throw error;
        await this.backend.deleteObject(key).catch(() => undefined);
        throw digestInvalid("uploaded content did not match the provided digest", { provided: digest });
      }
      this.state.offset = options.contentLength;
      return { digest, size: options.contentLength, storageKey: key };
    }

    // A body-less close is the common ending for both chunked and streamed
    // uploads. Skip the append so the carry object is not needlessly rewritten.
    const hasFinalChunk =
      body !== null && !(options.contentLength === 0 && options.contentRange === undefined);
    if (hasFinalChunk && body !== null) {
      // The closing PUT may carry the final chunk. Its Content-Length is not
      // trustworthy - clients set the header on body-less requests - so only
      // Content-Range is enforced here.
      await this.append(body, options, false);
    }

    const computed = `sha256:${Sha256.deserialize(this.state.hash).digestHex()}`;
    if (!digestEquals(computed, digest)) {
      await this.discard();
      throw digestInvalid("uploaded content did not match the provided digest", {
        provided: digest,
        computed,
      });
    }

    const size = this.state.offset;
    const multipart = this.state.multipart;

    if (multipart === null) {
      // Everything fits in one part: skip multipart entirely.
      const bytes = this.state.carrySize > 0 ? await this.backend.readCarry() : new Uint8Array(0);
      const key = this.backend.blobKey(digest);
      await this.backend.putObject(key, bytes, bytes.length, digestHex(digest));
      await this.deleteCarryIfPresent();
      return { digest, size, storageKey: key };
    }

    const parts = [...multipart.parts];
    if (this.state.carrySize > 0) {
      // The trailing part still counts against R2's ceiling.
      if (parts.length >= MAX_PARTS) throw sizeInvalid(`blob exceeds the maximum of ${MAX_PARTS} parts`);
      const carry = await this.backend.readCarry();
      parts.push(await this.backend.uploadPart(multipart.key, multipart.uploadId, parts.length + 1, carry));
    }

    await this.backend.completeMultipart(multipart.key, multipart.uploadId, parts);
    await this.deleteCarryIfPresent();

    // The multipart key was chosen before the digest was known, so the finished
    // object keeps its staging key. Deduplication is resolved by the metadata
    // store, which maps digest to key.
    return { digest, size, storageKey: multipart.key };
  }

  /** Releases every object this session created. */
  async discard(): Promise<void> {
    const multipart = this.state.multipart;
    if (multipart !== null) {
      await this.backend.abortMultipart(multipart.key, multipart.uploadId).catch(() => undefined);
    }
    await this.deleteCarryIfPresent();
  }

  private async deleteCarryIfPresent(): Promise<void> {
    if (this.state.carrySize > 0) await this.backend.deleteCarry().catch(() => undefined);
  }
}
