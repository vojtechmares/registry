import { blobUploadUnknown } from "@registry/oci";
import type { BlobRecord, ChunkOptions, UploadStatus, UploadStore } from "@registry/registry-core";
import { UPLOAD_SESSION_ID, type UploadSessionObject } from "../durable-objects/upload-session.js";
import { throwIfErrorResponse } from "../errors.js";

/** The DO's origin is never resolved; only the path and query matter. */
const ORIGIN = "https://upload-session.internal";

/**
 * Routes upload operations to the Durable Object that owns the session.
 *
 * The request body is forwarded as a stream, so a multi-gigabyte layer flows
 * Worker to Durable Object to R2 without ever being buffered.
 */
export class DurableObjectUploadStore implements UploadStore {
  constructor(private readonly namespace: DurableObjectNamespace<UploadSessionObject>) {}

  async create(repository: string): Promise<string> {
    const id = crypto.randomUUID();
    const response = await this.call(id, "/create", { repository, id });
    await throwIfErrorResponse(response);
    return id;
  }

  async status(repository: string, id: string): Promise<UploadStatus | null> {
    if (!UPLOAD_SESSION_ID.test(id)) return null;
    const response = await this.call(id, "/status", { repository });
    if (response.status === 404) return null;
    await throwIfErrorResponse(response);
    return response.json<UploadStatus>();
  }

  async append(
    repository: string,
    id: string,
    body: ReadableStream<Uint8Array>,
    options: ChunkOptions,
  ): Promise<UploadStatus> {
    this.requireSessionId(id);
    const response = await this.call(id, "/append", { repository, ...encodeChunk(options) }, body);
    await throwIfErrorResponse(response);
    return response.json<UploadStatus>();
  }

  async complete(
    repository: string,
    id: string,
    digest: string,
    body: ReadableStream<Uint8Array> | null,
    options: ChunkOptions,
  ): Promise<BlobRecord> {
    this.requireSessionId(id);
    const response = await this.call(id, "/complete", { repository, digest, ...encodeChunk(options) }, body);
    await throwIfErrorResponse(response);
    return response.json<BlobRecord>();
  }

  async cancel(repository: string, id: string): Promise<void> {
    if (!UPLOAD_SESSION_ID.test(id)) return;
    const response = await this.call(id, "/cancel", { repository });
    await throwIfErrorResponse(response);
  }

  /**
   * Refuses to address a Durable Object for a session id we never issued.
   * `idFromName` maps any string to a valid object, so without this a crafted
   * id would spin up an empty instance on every request.
   */
  private requireSessionId(id: string): void {
    if (!UPLOAD_SESSION_ID.test(id)) throw blobUploadUnknown();
  }

  private call(
    id: string,
    path: string,
    parameters: Record<string, string>,
    body?: ReadableStream<Uint8Array> | null,
  ): Promise<Response> {
    const stub = this.namespace.get(this.namespace.idFromName(id));
    const url = new URL(path, ORIGIN);
    for (const [key, value] of Object.entries(parameters)) url.searchParams.set(key, value);

    return stub.fetch(url.toString(), {
      method: "POST",
      ...(body === undefined || body === null ? {} : { body: body as unknown as BodyInit }),
    });
  }
}

function encodeChunk(options: ChunkOptions): Record<string, string> {
  const parameters: Record<string, string> = {};
  if (options.contentLength !== undefined) parameters.contentLength = String(options.contentLength);
  if (options.contentRange !== undefined) {
    parameters.rangeStart = String(options.contentRange.start);
    parameters.rangeEnd = String(options.contentRange.end);
  }
  return parameters;
}
