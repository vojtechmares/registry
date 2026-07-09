import { MEDIA_TYPE_OCTET_STREAM, OciError, blobUnknown, unsupported } from "@registry/oci";
import { errorResponse, parseRangeHeader } from "../http.js";
import type { RegistryContext } from "../ports.js";
import { requireDigest, requireRepositoryName } from "../validate.js";

export async function handleBlob(
  request: Request,
  route: { name: string; digest: string },
  ctx: RegistryContext,
): Promise<Response> {
  const name = requireRepositoryName(route.name);
  const digest = requireDigest(route.digest);

  switch (request.method) {
    case "GET":
    case "HEAD":
      return pullBlob(request, name, digest, ctx);
    case "DELETE":
      return deleteBlob(name, digest, ctx);
    default:
      return errorResponse(
        new OciError("UNSUPPORTED", `${request.method} is not supported here`, { status: 405 }),
      );
  }
}

async function pullBlob(
  request: Request,
  name: string,
  digest: string,
  ctx: RegistryContext,
): Promise<Response> {
  await ctx.authorize(name, "pull");

  const blob = await ctx.metadata.getLinkedBlob(name, digest);
  if (blob === null) throw blobUnknown(digest);

  const headers = new Headers({
    "Content-Type": MEDIA_TYPE_OCTET_STREAM,
    "Docker-Content-Digest": digest,
    "Accept-Ranges": "bytes",
    ETag: `"${digest}"`,
    "Cache-Control": "public, max-age=31536000, immutable",
  });

  if (request.method === "HEAD") {
    headers.set("Content-Length", String(blob.size));
    return new Response(null, { status: 200, headers });
  }

  const range = parseRangeHeader(request.headers.get("Range"), blob.size);
  if (range.kind === "unsatisfiable") {
    headers.set("Content-Range", `bytes */${blob.size}`);
    return new Response(null, { status: 416, headers });
  }

  if (range.kind === "range") {
    const length = range.end - range.start + 1;
    const body = await ctx.content.get(blob.storageKey, { offset: range.start, length });
    // Metadata said the blob exists; if the object is gone the two have diverged.
    if (body === null) throw blobUnknown(digest);
    headers.set("Content-Length", String(length));
    headers.set("Content-Range", `bytes ${range.start}-${range.end}/${blob.size}`);
    return new Response(body.body, { status: 206, headers });
  }

  const body = await ctx.content.get(blob.storageKey);
  if (body === null) throw blobUnknown(digest);
  headers.set("Content-Length", String(blob.size));
  return new Response(body.body, { status: 200, headers });
}

/**
 * Unlinks the blob from this repository rather than erasing its bytes: the same
 * content is very likely shared with other repositories through deduplication.
 * Reclaiming the bytes is garbage collection's job, once no repository links them.
 */
async function deleteBlob(name: string, digest: string, ctx: RegistryContext): Promise<Response> {
  await ctx.authorize(name, "delete");
  if (!ctx.config.enableDeletes) throw unsupported("blob deletion is disabled");

  const removed = await ctx.metadata.unlinkBlob(name, digest);
  if (!removed) throw blobUnknown(digest);

  return new Response(null, { status: 202, headers: { "Content-Length": "0" } });
}
