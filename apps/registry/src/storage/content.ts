import { ContentIntegrityError, type BlobBody, type ContentStore } from "@registry/registry-core";
import { blobKey, manifestKey } from "../keys.js";

/**
 * R2 error codes that mean "the bytes were not what the client promised".
 * https://developers.cloudflare.com/r2/api/error-codes/
 */
const BAD_DIGEST = 10037;

/**
 * Distinguishes a client's bad checksum or length from a bucket that is simply
 * unavailable. Getting this wrong turns an outage into a stream of 400s, which
 * would tell every client to give up rather than retry.
 */
export function isIntegrityError(error: unknown): boolean {
  if (error instanceof ContentIntegrityError) return true;
  if (typeof error !== "object" || error === null) return false;

  const code = (error as { code?: unknown }).code;
  if (code === BAD_DIGEST) return true;

  const message = (error as { message?: unknown }).message;
  if (typeof message !== "string") return false;
  // A FixedLengthStream that receives the wrong number of bytes rejects here,
  // which happens when Content-Length disagrees with the body.
  return /checksum|baddigest|did not match|too (?:few|many) bytes|length of stream/i.test(message);
}

/**
 * Streams `body` into R2 with a known length.
 *
 * R2 will not accept a stream of unknown size, and buffering a container layer
 * to learn its size is not an option inside a Worker. `FixedLengthStream` gives
 * the runtime the length up front and fails the write if the body disagrees.
 */
function fixedLength(
  body: ReadableStream<Uint8Array>,
  size: number,
): {
  readable: ReadableStream;
  pumped: Promise<void>;
} {
  const stream = new FixedLengthStream(size);
  const pumped = body.pipeTo(stream.writable);
  return { readable: stream.readable, pumped };
}

/**
 * Writes `body` into R2 under `key`, verifying it is exactly `size` bytes and
 * hashes to `sha256Hex`. R2 checks the digest server-side and rejects a
 * mismatch, so the bytes are never observable at the key unless they are
 * correct. An integrity failure - bad checksum, wrong length - surfaces as a
 * `ContentIntegrityError`; a bucket outage propagates unchanged, so it is
 * retried rather than reported to the client as a bad digest.
 *
 * The one place a body is written with integrity, so the content store and the
 * upload session's carry-and-part backend cannot drift apart.
 */
export async function putVerified(
  bucket: R2Bucket,
  key: string,
  body: ReadableStream<Uint8Array> | Uint8Array,
  size: number,
  sha256Hex: string,
): Promise<void> {
  try {
    if (body instanceof Uint8Array) {
      if (body.length !== size) {
        throw new ContentIntegrityError(`expected ${size} bytes, received ${body.length}`);
      }
      await bucket.put(key, body as unknown as ArrayBufferView, { sha256: sha256Hex });
      return;
    }

    const { readable, pumped } = fixedLength(body, size);
    const write = bucket.put(key, readable, { sha256: sha256Hex });
    // Surface whichever side fails first: a short body rejects `pumped`, a bad
    // checksum rejects `write`.
    const [pumpResult, writeResult] = await Promise.allSettled([pumped, write]);
    if (writeResult.status === "rejected") throw writeResult.reason;
    if (pumpResult.status === "rejected") throw pumpResult.reason;
  } catch (error) {
    if (isIntegrityError(error)) {
      throw new ContentIntegrityError(
        error instanceof Error ? error.message : "content integrity check failed",
      );
    }
    throw error;
  }
}

export class R2ContentStore implements ContentStore {
  constructor(private readonly bucket: R2Bucket) {}

  blobKey(digest: string): string {
    return blobKey(digest);
  }

  manifestKey(digest: string): string {
    return manifestKey(digest);
  }

  async get(storageKey: string, range?: { offset: number; length: number }): Promise<BlobBody | null> {
    const object = await this.bucket.get(storageKey, range === undefined ? undefined : { range });
    if (object === null || object.body === null) return null;

    return {
      body: object.body as unknown as ReadableStream<Uint8Array>,
      size: range?.length ?? object.size,
      totalSize: object.size,
    };
  }

  async put(
    storageKey: string,
    body: ReadableStream<Uint8Array> | Uint8Array,
    size: number,
    sha256Hex: string,
  ): Promise<void> {
    await putVerified(this.bucket, storageKey, body, size, sha256Hex);
  }

  async delete(storageKey: string): Promise<void> {
    await this.bucket.delete(storageKey);
  }
}
