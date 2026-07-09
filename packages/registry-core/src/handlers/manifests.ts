import {
  OciError,
  digestEquals,
  digestOfAsync,
  manifestBlobUnknown,
  manifestUnknown,
  parseManifest,
  referencedContent,
  referrerArtifactType,
  unsupported,
} from "@registry/oci";
import type { Manifest } from "@registry/oci";
import { errorResponse, readBodyLimited } from "../http.js";
import { eventsOf, policyOf } from "../ports.js";
import type { ManifestRecord, RegistryContext } from "../ports.js";
import { digestHex, parseReference, requireRepositoryName } from "../validate.js";

export async function handleManifest(
  request: Request,
  route: { name: string; reference: string },
  ctx: RegistryContext,
): Promise<Response> {
  const name = requireRepositoryName(route.name);

  switch (request.method) {
    case "GET":
    case "HEAD":
      return pullManifest(request, name, route.reference, ctx);
    case "PUT":
      return pushManifest(request, name, route.reference, ctx);
    case "DELETE":
      return deleteManifest(name, route.reference, ctx);
    default:
      return errorResponse(
        new OciError("UNSUPPORTED", `${request.method} is not supported here`, { status: 405 }),
      );
  }
}

async function pullManifest(
  request: Request,
  name: string,
  reference: string,
  ctx: RegistryContext,
): Promise<Response> {
  const parsed = parseReference(reference);
  await ctx.authorize(name, "pull");

  const digest = parsed.kind === "digest" ? parsed.digest : await ctx.metadata.resolveTag(name, parsed.tag);
  if (digest === null) throw manifestUnknown(reference);

  const record = await ctx.metadata.getManifest(name, digest);
  if (record === null) throw manifestUnknown(reference);

  await policyOf(ctx).beforeManifestPull(name, record);

  const headers = new Headers({
    "Content-Type": record.mediaType,
    "Content-Length": String(record.size),
    "Docker-Content-Digest": digest,
    ETag: `"${digest}"`,
  });

  if (request.method === "HEAD") return new Response(null, { status: 200, headers });

  const body = await ctx.content.get(ctx.content.manifestKey(digest));
  if (body === null) throw manifestUnknown(reference);

  eventsOf(ctx).manifestPulled(name, record, reference);
  return new Response(body.body, { status: 200, headers });
}

async function pushManifest(
  request: Request,
  name: string,
  reference: string,
  ctx: RegistryContext,
): Promise<Response> {
  const parsed = parseReference(reference, true);
  await ctx.authorize(name, "push");

  const body = await readBodyLimited(request, ctx.config.maxManifestSize);
  const contentType = request.headers.get("Content-Type");
  const manifest = parseManifest(body, contentType ?? undefined);

  // The digest is over the exact bytes the client sent. Nothing may re-serialise
  // the document, or the digest the client computed would stop matching ours.
  const digest = await digestOfAsync(body);
  if (parsed.kind === "digest" && !digestEquals(parsed.digest, digest)) {
    throw new OciError("DIGEST_INVALID", "provided digest did not match uploaded content", {
      detail: { provided: parsed.digest, computed: digest },
    });
  }

  await ensureReferencesExist(name, manifest, ctx);

  const artifactType = referrerArtifactType(manifest);
  const record: ManifestRecord = {
    digest,
    mediaType: manifest.mediaType,
    size: body.length,
    artifactType: artifactType ?? null,
    subjectDigest: manifest.subject?.digest ?? null,
    annotations: manifest.annotations ?? null,
  };

  // Ahead of every write, so that a refusal leaves nothing behind: no manifest
  // object in the bucket, no repository row for a project that never accepted it.
  const tag = parsed.kind === "tag" ? parsed.tag : null;
  await policyOf(ctx).beforeManifestPush(name, record, tag);

  await ctx.metadata.ensureRepository(name);
  await ctx.content.put(ctx.content.manifestKey(digest), body, body.length, digestHex(digest));

  await ctx.metadata.putManifest(name, record, referencedContent(manifest));
  if (tag !== null) await ctx.metadata.tagManifest(name, tag, digest);
  eventsOf(ctx).manifestPushed(name, record, tag);

  const headers = new Headers({
    Location: `/v2/${name}/manifests/${digest}`,
    "Docker-Content-Digest": digest,
    "Content-Length": "0",
  });
  // Tells the client the registry indexed the subject itself, so the client
  // need not maintain the fallback referrers tag.
  if (manifest.subject !== undefined) headers.set("OCI-Subject", manifest.subject.digest);

  return new Response(null, { status: 201, headers });
}

/**
 * A manifest may only be accepted once the content it names is present.
 *
 * `subject` is deliberately exempt: the spec requires a registry to accept a
 * manifest whose subject has not been pushed yet, so that a client may push an
 * artifact and its referrers in either order.
 */
async function ensureReferencesExist(name: string, manifest: Manifest, ctx: RegistryContext): Promise<void> {
  const { blobs, manifests } = referencedContent(manifest);

  if (ctx.config.validateBlobReferences && blobs.length > 0) {
    const missing = await ctx.metadata.missingLinkedBlobs(name, blobs);
    if (missing.length > 0) throw manifestBlobUnknown(missing[0]!);
  }

  if (ctx.config.validateManifestReferences && manifests.length > 0) {
    const missing = await ctx.metadata.missingManifests(name, manifests);
    if (missing.length > 0) throw manifestBlobUnknown(missing[0]!);
  }
}

async function deleteManifest(name: string, reference: string, ctx: RegistryContext): Promise<Response> {
  const parsed = parseReference(reference);
  await ctx.authorize(name, "delete");
  if (!ctx.config.enableDeletes) throw unsupported("manifest deletion is disabled");

  // Deleting by digest removes the manifest and every tag that pointed at it.
  // Deleting by tag removes only the tag; the manifest survives for other tags.
  const removed =
    parsed.kind === "digest"
      ? await ctx.metadata.deleteManifest(name, parsed.digest)
      : await ctx.metadata.deleteTag(name, parsed.tag);

  if (!removed) throw manifestUnknown(reference);

  if (parsed.kind === "digest") eventsOf(ctx).manifestDeleted(name, parsed.digest);
  else eventsOf(ctx).tagDeleted(name, parsed.tag);

  return new Response(null, { status: 202, headers: { "Content-Length": "0" } });
}
