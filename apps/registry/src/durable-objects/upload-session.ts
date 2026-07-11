import { DurableObject } from "cloudflare:workers";
import { OciError, blobUploadUnknown } from "@registry/oci";
import {
  UploadSession,
  createSessionState,
  emptyStream,
  type ChunkOptions,
  type SessionBackend,
  type SessionState,
  type UploadedPart,
} from "@registry/registry-core";
import type { Env } from "../env.js";
import { putVerified } from "../storage/content.js";
import { toErrorResponse } from "../errors.js";
import { blobKey, carryKey, stagingKey } from "../keys.js";

export const UPLOAD_SESSION_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

const STATE_KEY = "session";

/** Abandoned sessions are reaped, releasing their carry object and multipart upload. */
const SESSION_TTL_MS = 24 * 60 * 60 * 1000;

interface StoredSession extends SessionState {
  readonly id: string;
  readonly createdAt: number;
}

/**
 * Owns one blob upload for its lifetime.
 *
 * A chunked upload is a read-modify-write over the session's offset, its carry
 * object, and its SHA-256 mid-state. D1 offers no serialisability for that, and
 * two PATCHes racing would silently corrupt the blob. A Durable Object gives us
 * a single owner per session; the promise chain below adds the ordering that a
 * Durable Object does not provide on its own, since it will happily deliver
 * concurrent requests to the same instance.
 */
export class UploadSessionObject extends DurableObject<Env> {
  private tail: Promise<unknown> = Promise.resolve();

  override async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    try {
      return await this.serialize(() => this.route(url, request));
    } catch (error) {
      if (error instanceof OciError) return toErrorResponse(error);
      throw error;
    }
  }

  /** Runs `task` after every task already queued, so chunks apply in arrival order. */
  private serialize<T>(task: () => Promise<T>): Promise<T> {
    const result = this.tail.then(task, task);
    this.tail = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }

  private async route(url: URL, request: Request): Promise<Response> {
    switch (url.pathname) {
      case "/create":
        return this.create(url);
      case "/status":
        return this.status();
      case "/append":
        return this.append(url, request);
      case "/complete":
        return this.complete(url, request);
      case "/cancel":
        return this.cancel();
      default:
        return new Response("not found", { status: 404 });
    }
  }

  private async create(url: URL): Promise<Response> {
    const repository = required(url, "repository");
    const id = required(url, "id");
    const session: StoredSession = { ...createSessionState(repository), id, createdAt: Date.now() };
    await this.ctx.storage.put(STATE_KEY, session);
    await this.ctx.storage.setAlarm(Date.now() + SESSION_TTL_MS);
    return Response.json({ id, offset: 0 });
  }

  private async status(): Promise<Response> {
    const session = await this.load();
    return Response.json({ id: session.id, repository: session.repository, offset: session.offset });
  }

  private async append(url: URL, request: Request): Promise<Response> {
    const session = await this.load(required(url, "repository"));
    const upload = new UploadSession(this.backend(session.id), session);

    await upload.append(request.body ?? emptyStream(), chunkOptions(url));
    await this.save(session);

    return Response.json({ id: session.id, repository: session.repository, offset: session.offset });
  }

  private async complete(url: URL, request: Request): Promise<Response> {
    const session = await this.load(required(url, "repository"));
    const upload = new UploadSession(this.backend(session.id), session);

    try {
      const record = await upload.complete(required(url, "digest"), request.body, chunkOptions(url));
      // The session is spent. Keeping it would let a client re-PUT a different
      // digest against bytes already handed to the blob store.
      await this.destroy();
      return Response.json(record);
    } catch (error) {
      if (error instanceof OciError) {
        // A digest mismatch is terminal: `UploadSession` has already released
        // the multipart upload and the carry object. Anything else - an
        // out-of-order final chunk, a bad length - leaves the session usable, so
        // the client may correct itself and close again.
        if (error.code === "DIGEST_INVALID") await this.destroy();
        throw error;
      }
      // Transient failure. Persist nothing new; the client retries the close.
      throw error;
    }
  }

  private async cancel(): Promise<Response> {
    const session = await this.ctx.storage.get<StoredSession>(STATE_KEY);
    if (session !== undefined) {
      await new UploadSession(this.backend(session.id), session).discard();
      await this.destroy();
    }
    return new Response(null, { status: 204 });
  }

  /** Reaps a session the client walked away from. */
  override async alarm(): Promise<void> {
    await this.serialize(async () => {
      const session = await this.ctx.storage.get<StoredSession>(STATE_KEY);
      if (session !== undefined) {
        await new UploadSession(this.backend(session.id), session).discard().catch(() => undefined);
      }
      await this.ctx.storage.deleteAll();
    });
  }

  private async load(repository?: string): Promise<StoredSession> {
    const session = await this.ctx.storage.get<StoredSession>(STATE_KEY);
    // A session belongs to the repository that opened it. Refusing a mismatch
    // stops one repository from closing another's upload against its own blob.
    if (session === undefined || (repository !== undefined && session.repository !== repository)) {
      throw blobUploadUnknown();
    }
    return session;
  }

  private async save(session: StoredSession): Promise<void> {
    await this.ctx.storage.put(STATE_KEY, session);
  }

  private async destroy(): Promise<void> {
    await this.ctx.storage.deleteAlarm();
    await this.ctx.storage.deleteAll();
  }

  private backend(id: string): SessionBackend {
    return new R2SessionBackend(this.env.BUCKET, id);
  }
}

/** Drives {@link UploadSession}'s carry-and-part machinery against R2. */
class R2SessionBackend implements SessionBackend {
  constructor(
    private readonly bucket: R2Bucket,
    private readonly id: string,
  ) {}

  private get carry(): string {
    return carryKey(this.id);
  }

  async readCarry(): Promise<Uint8Array> {
    const object = await this.bucket.get(this.carry);
    if (object === null) return new Uint8Array(0);
    return new Uint8Array(await object.arrayBuffer());
  }

  async writeCarry(bytes: Uint8Array): Promise<void> {
    await this.bucket.put(this.carry, bytes as unknown as ArrayBufferView);
  }

  async deleteCarry(): Promise<void> {
    await this.bucket.delete(this.carry);
  }

  async createMultipart(key: string): Promise<string> {
    const upload = await this.bucket.createMultipartUpload(key);
    return upload.uploadId;
  }

  async uploadPart(
    key: string,
    uploadId: string,
    partNumber: number,
    bytes: Uint8Array,
  ): Promise<UploadedPart> {
    const upload = this.bucket.resumeMultipartUpload(key, uploadId);
    // `bytes` is a view onto a window that the caller reuses, so copy it: R2 may
    // still be reading when the next chunk starts filling the window.
    const part = await upload.uploadPart(partNumber, bytes.slice() as unknown as ArrayBuffer);
    return { partNumber: part.partNumber, etag: part.etag };
  }

  async completeMultipart(key: string, uploadId: string, parts: readonly UploadedPart[]): Promise<void> {
    const upload = this.bucket.resumeMultipartUpload(key, uploadId);
    await upload.complete(parts as R2UploadedPart[]);
  }

  async abortMultipart(key: string, uploadId: string): Promise<void> {
    await this.bucket.resumeMultipartUpload(key, uploadId).abort();
  }

  async putObject(
    key: string,
    body: ReadableStream<Uint8Array> | Uint8Array,
    size: number,
    sha256Hex: string,
  ): Promise<void> {
    await putVerified(this.bucket, key, body, size, sha256Hex);
  }

  async deleteObject(key: string): Promise<void> {
    await this.bucket.delete(key);
  }

  blobKey(digest: string): string {
    return blobKey(digest);
  }

  stagingKey(): string {
    return stagingKey(this.id);
  }
}

function required(url: URL, name: string): string {
  const value = url.searchParams.get(name);
  if (value === null) throw new Error(`missing ${name} parameter`);
  return value;
}

function chunkOptions(url: URL): ChunkOptions {
  const options: { -readonly [K in keyof ChunkOptions]: ChunkOptions[K] } = {};

  const contentLength = url.searchParams.get("contentLength");
  if (contentLength !== null) options.contentLength = Number(contentLength);

  const start = url.searchParams.get("rangeStart");
  const end = url.searchParams.get("rangeEnd");
  if (start !== null && end !== null) options.contentRange = { start: Number(start), end: Number(end) };

  return options;
}
