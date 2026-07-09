import { OciError } from "@registry/oci";
import { handleBlob } from "./handlers/blobs.js";
import { handleManifest } from "./handlers/manifests.js";
import { handleReferrers } from "./handlers/referrers.js";
import { handleTags } from "./handlers/tags.js";
import { handleUpload, handleUploads } from "./handlers/uploads.js";
import { API_VERSION, API_VERSION_HEADER, errorResponse, jsonResponse } from "./http.js";
import type { RegistryContext } from "./ports.js";
import { matchRoute } from "./router.js";

/**
 * Serves the `/v2/` distribution API.
 *
 * Returns `null` when the path is outside `/v2/`, leaving the caller free to
 * mount a dashboard or a management API alongside the registry.
 */
export async function handleRegistryRequest(
  request: Request,
  ctx: RegistryContext,
): Promise<Response | null> {
  const url = new URL(request.url);
  const route = matchRoute(url.pathname);
  if (route === null) return null;

  try {
    return await dispatch(request, route, ctx);
  } catch (error) {
    if (error instanceof OciError) return errorResponse(error);
    throw error;
  }
}

async function dispatch(
  request: Request,
  route: NonNullable<ReturnType<typeof matchRoute>>,
  ctx: RegistryContext,
): Promise<Response> {
  switch (route.kind) {
    case "base":
      return handleBase(request, ctx);
    case "uploads":
      return handleUploads(request, route, ctx);
    case "upload":
      return handleUpload(request, route, ctx);
    case "blob":
      return handleBlob(request, route, ctx);
    case "manifest":
      return handleManifest(request, route, ctx);
    case "tags":
      return handleTags(request, route, ctx);
    case "referrers":
      return handleReferrers(request, route, ctx);
  }
}

/**
 * `GET /v2/` - the endpoint clients probe to discover both that this is a v2
 * registry and, via a 401, how to authenticate against it.
 */
async function handleBase(request: Request, ctx: RegistryContext): Promise<Response> {
  if (request.method !== "GET" && request.method !== "HEAD") {
    return errorResponse(
      new OciError("UNSUPPORTED", `${request.method} is not supported here`, { status: 405 }),
    );
  }

  // An empty repository name denotes registry scope.
  await ctx.authorize("", "pull");

  return jsonResponse({}, { headers: { [API_VERSION_HEADER]: API_VERSION } });
}
