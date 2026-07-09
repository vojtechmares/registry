import { OciError, nameUnknown } from "@registry/oci";
import { errorResponse, jsonResponse, nextLink } from "../http.js";
import type { RegistryContext } from "../ports.js";
import { parsePageSize, requireRepositoryName } from "../validate.js";

export async function handleTags(
  request: Request,
  route: { name: string },
  ctx: RegistryContext,
): Promise<Response> {
  const name = requireRepositoryName(route.name);
  if (request.method !== "GET" && request.method !== "HEAD") {
    return errorResponse(
      new OciError("UNSUPPORTED", `${request.method} is not supported here`, { status: 405 }),
    );
  }

  await ctx.authorize(name, "pull");
  if (!(await ctx.metadata.repositoryExists(name))) throw nameUnknown(name);

  const url = new URL(request.url);
  const requested = parsePageSize(url.searchParams.get("n"));
  const last = url.searchParams.get("last") ?? undefined;

  // `n=0` means an empty page, and explicitly no `Link` header.
  if (requested === 0) return jsonResponse({ name, tags: [] });

  const limit = requested ?? ctx.config.defaultTagPageSize;
  const page = await ctx.metadata.listTags(name, last === undefined ? { limit } : { limit, last });

  const headers = new Headers();
  if (page.hasMore && page.tags.length > 0) {
    const parameters: Record<string, string> = {
      n: String(limit),
      last: page.tags[page.tags.length - 1]!,
    };
    headers.set("Link", nextLink(`/v2/${name}/tags/list`, parameters));
  }

  return jsonResponse({ name, tags: page.tags }, { headers });
}
