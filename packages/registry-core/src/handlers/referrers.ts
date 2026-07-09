import { MEDIA_TYPE_OCI_INDEX, OciError } from "@registry/oci";
import type { Descriptor } from "@registry/oci";
import { errorResponse } from "../http.js";
import type { ReferrerRecord, RegistryContext } from "../ports.js";
import { requireDigest, requireRepositoryName } from "../validate.js";

/**
 * `GET /v2/<name>/referrers/<digest>` - every manifest whose `subject` names `<digest>`.
 *
 * A registry that implements this API must never answer 404, because a 404 is
 * the signal that tells clients to fall back to the referrers *tag* schema.
 * An unknown repository or an unreferenced subject therefore returns an empty
 * index, not a miss.
 */
export async function handleReferrers(
  request: Request,
  route: { name: string; digest: string },
  ctx: RegistryContext,
): Promise<Response> {
  const name = requireRepositoryName(route.name);
  const digest = requireDigest(route.digest);

  if (request.method !== "GET" && request.method !== "HEAD") {
    return errorResponse(
      new OciError("UNSUPPORTED", `${request.method} is not supported here`, { status: 405 }),
    );
  }

  await ctx.authorize(name, "pull");

  const url = new URL(request.url);
  const artifactType = url.searchParams.get("artifactType");

  const records = await ctx.metadata.listReferrers(name, digest);
  const filtered =
    artifactType === null || artifactType === ""
      ? records
      : records.filter((record) => record.artifactType === artifactType);

  const headers = new Headers({ "Content-Type": MEDIA_TYPE_OCI_INDEX });
  if (artifactType !== null && artifactType !== "") headers.set("OCI-Filters-Applied", "artifactType");

  const body = {
    schemaVersion: 2,
    mediaType: MEDIA_TYPE_OCI_INDEX,
    manifests: filtered.map(toDescriptor),
  };

  if (request.method === "HEAD") {
    headers.set("Content-Length", String(new TextEncoder().encode(JSON.stringify(body)).length));
    return new Response(null, { status: 200, headers });
  }

  return new Response(JSON.stringify(body), { status: 200, headers });
}

function toDescriptor(record: ReferrerRecord): Descriptor {
  const descriptor: { -readonly [K in keyof Descriptor]: Descriptor[K] } = {
    mediaType: record.mediaType,
    digest: record.digest,
    size: record.size,
  };
  if (record.artifactType !== null) descriptor.artifactType = record.artifactType;
  if (record.annotations !== null) descriptor.annotations = record.annotations;
  return descriptor;
}
