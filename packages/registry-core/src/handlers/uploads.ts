import {
  OciError,
  blobUploadInvalid,
  blobUploadUnknown,
  digestInvalid,
  isValidDigest,
  isValidRepositoryName,
  sizeInvalid,
} from "@registry/oci";
import { emptyStream, errorResponse, parseContentRange, uploadRange } from "../http.js";
import { ContentIntegrityError, eventsOf, policyOf } from "../ports.js";
import type { BlobRecord, ChunkOptions, RegistryContext } from "../ports.js";
import { digestHex, requireRepositoryName } from "../validate.js";

/** `POST /v2/<name>/blobs/uploads/` - start a session, mount, or upload in one shot. */
export async function handleUploads(
  request: Request,
  route: { name: string },
  ctx: RegistryContext,
): Promise<Response> {
  const name = requireRepositoryName(route.name);
  if (request.method !== "POST") {
    return errorResponse(
      new OciError("UNSUPPORTED", `${request.method} is not supported here`, { status: 405 }),
    );
  }

  await ctx.authorize(name, "push");

  const url = new URL(request.url);
  const mount = url.searchParams.get("mount");
  const digest = url.searchParams.get("digest");

  // The repository is created inside each path, only once its policy check has
  // passed, so an upload a full or unsigned project refuses leaves no empty row.
  if (mount !== null) return crossMount(name, mount, url.searchParams.get("from"), ctx);
  if (digest !== null) return monolithicPost(request, name, digest, ctx);

  return beginSession(name, ctx);
}

async function beginSession(name: string, ctx: RegistryContext): Promise<Response> {
  // Opening a session is the client committing to an upload, so the repository
  // is created now: the later completion charges the project's quota, which
  // needs the project row to exist.
  await ctx.metadata.ensureRepository(name);
  const id = await ctx.uploads.create(name);
  return new Response(null, {
    status: 202,
    headers: {
      Location: `/v2/${name}/blobs/uploads/${id}`,
      Range: uploadRange(0),
      "Docker-Upload-UUID": id,
      "Content-Length": "0",
    },
  });
}

/**
 * `?mount=<digest>&from=<other>` links content this registry already holds into
 * a second repository, no bytes transferred.
 *
 * Anything that prevents the mount - unknown blob, no read access to `from`,
 * malformed digest - degrades to opening an ordinary upload session (202)
 * rather than failing. That is what the spec asks for, and it means the client
 * simply uploads the blob it was going to upload anyway.
 */
async function crossMount(
  name: string,
  mount: string,
  from: string | null,
  ctx: RegistryContext,
): Promise<Response> {
  const source = isValidDigest(mount) ? await findMountSource(name, mount, from, ctx) : null;
  if (source === null) return beginSession(name, ctx);

  // A mount transfers no bytes, but it does make a second project responsible
  // for them. It is a write, and it is charged and vetted like any other -
  // before the repository is created, so a refusal leaves nothing behind.
  await policyOf(ctx).beforeBlobLink(name, { digest: mount, size: source.size });

  await ctx.metadata.ensureRepository(name);

  // The blob was there a moment ago. If it has since been collected, ask the
  // client to upload it rather than hand back a link to nothing.
  if (!(await ctx.metadata.linkBlob(name, mount))) return beginSession(name, ctx);

  return new Response(null, {
    status: 201,
    headers: {
      Location: `/v2/${name}/blobs/${mount}`,
      "Docker-Content-Digest": mount,
      "Content-Length": "0",
    },
  });
}

/** How many candidate source repositories automatic cross-mount will consider. */
const MAX_MOUNT_CANDIDATES = 50;

async function findMountSource(
  name: string,
  digest: string,
  from: string | null,
  ctx: RegistryContext,
): Promise<BlobRecord | null> {
  if (from !== null && from !== "" && from !== name && isValidRepositoryName(from)) {
    const linked = await readableBlob(from, digest, ctx);
    if (linked !== null) return linked;
    // Named a source we cannot read: fall through to an upload session.
    return null;
  }

  if (!ctx.config.automaticCrossMount) return null;

  // `from` is optional, but "any repository holds these bytes" must not become
  // "any caller may read these bytes". Content addressing makes the blob
  // identical everywhere, yet the right to pull it is per-repository. So mount
  // only from a repository this caller could pull from anyway - never straight
  // out of a private repo they have no access to.
  const candidates = await ctx.metadata.repositoriesLinkingBlob(digest, MAX_MOUNT_CANDIDATES);
  for (const candidate of candidates) {
    if (candidate === name) continue;
    const linked = await readableBlob(candidate, digest, ctx);
    if (linked !== null) return linked;
  }
  return null;
}

/** The blob within `repository`, but only if the caller may pull that repository. */
async function readableBlob(
  repository: string,
  digest: string,
  ctx: RegistryContext,
): Promise<BlobRecord | null> {
  try {
    await ctx.authorize(repository, "pull");
  } catch (error) {
    if (error instanceof OciError) return null;
    throw error;
  }
  return ctx.metadata.getLinkedBlob(repository, digest);
}

/** `POST /v2/<name>/blobs/uploads/?digest=<digest>` with the whole blob in the body. */
async function monolithicPost(
  request: Request,
  name: string,
  digest: string,
  ctx: RegistryContext,
): Promise<Response> {
  if (!isValidDigest(digest)) throw digestInvalid(`"${digest}" is not a valid digest`);

  const size = contentLength(request);
  if (size === null) throw sizeInvalid("Content-Length is required for a monolithic upload");

  await policyOf(ctx).beforeBlobLink(name, { digest, size });

  await ctx.metadata.ensureRepository(name);

  const key = ctx.content.blobKey(digest);
  await putVerified(ctx, key, request.body ?? emptyStream(), size, digest);
  await registerAndLink(ctx, name, { digest, size, storageKey: key });

  return created(name, digest);
}

/** `GET|PATCH|PUT|DELETE /v2/<name>/blobs/uploads/<id>` */
export async function handleUpload(
  request: Request,
  route: { name: string; id: string },
  ctx: RegistryContext,
): Promise<Response> {
  const name = requireRepositoryName(route.name);
  await ctx.authorize(name, "push");

  switch (request.method) {
    case "GET":
      return uploadStatus(name, route.id, ctx);
    case "PATCH":
      return patchChunk(request, name, route.id, ctx);
    case "PUT":
      return completeUpload(request, name, route.id, ctx);
    case "DELETE":
      await ctx.uploads.cancel(name, route.id);
      return new Response(null, { status: 204, headers: { "Content-Length": "0" } });
    default:
      return errorResponse(
        new OciError("UNSUPPORTED", `${request.method} is not supported here`, { status: 405 }),
      );
  }
}

async function uploadStatus(name: string, id: string, ctx: RegistryContext): Promise<Response> {
  const status = await ctx.uploads.status(name, id);
  if (status === null) throw blobUploadUnknown();

  return new Response(null, {
    status: 204,
    headers: {
      Location: `/v2/${name}/blobs/uploads/${id}`,
      Range: uploadRange(status.offset),
      "Docker-Upload-UUID": id,
      "Content-Length": "0",
    },
  });
}

async function patchChunk(
  request: Request,
  name: string,
  id: string,
  ctx: RegistryContext,
): Promise<Response> {
  const options = chunkOptions(request);
  const status = await ctx.uploads.append(name, id, request.body ?? emptyStream(), options);

  return new Response(null, {
    status: 202,
    headers: {
      Location: `/v2/${name}/blobs/uploads/${id}`,
      Range: uploadRange(status.offset),
      "Docker-Upload-UUID": id,
      "Content-Length": "0",
    },
  });
}

async function completeUpload(
  request: Request,
  name: string,
  id: string,
  ctx: RegistryContext,
): Promise<Response> {
  const url = new URL(request.url);
  const digest = url.searchParams.get("digest");
  if (digest === null) throw blobUploadInvalid("the digest query parameter is required to close an upload");
  if (!isValidDigest(digest)) throw digestInvalid(`"${digest}" is not a valid digest`);

  const record = await ctx.uploads.complete(name, id, digest, request.body, chunkOptions(request));
  // The size is only known once the last chunk has landed, so the quota is
  // checked here rather than when the session opened. Content that a full
  // project refuses is left unlinked, and garbage collection reclaims it.
  await policyOf(ctx).beforeBlobLink(name, { digest, size: record.size });
  await registerAndLink(ctx, name, record);

  return created(name, digest);
}

/**
 * Records the blob and links it into this repository, in one commit.
 *
 * Deduplication happens here: if identical bytes were already stored under a
 * different key, the incumbent record comes back and we drop the object we just
 * wrote. Losing that race costs one wasted write, never a corrupt pointer.
 */
async function registerAndLink(ctx: RegistryContext, name: string, record: BlobRecord): Promise<void> {
  const stored = await ctx.metadata.registerAndLinkBlob(name, record);
  if (stored.storageKey !== record.storageKey) {
    await ctx.content.delete(record.storageKey);
  }
  eventsOf(ctx).blobPushed(name, { digest: record.digest, size: record.size });
}

async function putVerified(
  ctx: RegistryContext,
  key: string,
  body: ReadableStream<Uint8Array> | Uint8Array,
  size: number,
  digest: string,
): Promise<void> {
  try {
    await ctx.content.put(key, body, size, digestHex(digest));
  } catch (error) {
    // Only an integrity failure is the client's fault. A bucket outage must not
    // be reported as a bad digest.
    if (!(error instanceof ContentIntegrityError)) throw error;
    await ctx.content.delete(key).catch(() => undefined);
    throw digestInvalid("uploaded content did not match the provided digest", { digest });
  }
}

function created(name: string, digest: string): Response {
  return new Response(null, {
    status: 201,
    headers: {
      Location: `/v2/${name}/blobs/${digest}`,
      "Docker-Content-Digest": digest,
      "Content-Length": "0",
    },
  });
}

function contentLength(request: Request): number | null {
  const raw = request.headers.get("Content-Length");
  if (raw === null) return null;
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value < 0) throw sizeInvalid(`invalid Content-Length "${raw}"`);
  return value;
}

function chunkOptions(request: Request): ChunkOptions {
  const options: { -readonly [K in keyof ChunkOptions]: ChunkOptions[K] } = {};

  const length = contentLength(request);
  if (length !== null) options.contentLength = length;

  const rawRange = request.headers.get("Content-Range");
  if (rawRange !== null) {
    const range = parseContentRange(rawRange);
    if (range === null) throw blobUploadInvalid(`invalid Content-Range "${rawRange}"`);
    if (length !== null && range.end - range.start + 1 !== length) {
      throw sizeInvalid("Content-Range does not agree with Content-Length");
    }
    options.contentRange = range;
  }

  return options;
}
