import type { Authorize } from "@registry/registry-core";
import type { Principal } from "../auth/principal.js";
import type { Env } from "../env.js";
import { RepositoryStore } from "../storage/repositories.js";
import { audienceOf } from "../visibility.js";

/** `GET /v2/_catalog` - the Docker catalog endpoint, outside the OCI spec but widely used. */
export async function handleCatalog(
  request: Request,
  env: Env,
  principal: Principal,
  authorize: Authorize,
): Promise<Response> {
  if (request.method !== "GET" && request.method !== "HEAD") {
    return new Response("method not allowed", { status: 405, headers: { Allow: "GET, HEAD" } });
  }

  // Registry-scope authorization. When anonymous pull is disabled this
  // challenges an anonymous caller rather than quietly listing public names.
  await authorize("", "pull");

  const url = new URL(request.url);
  const limit = Math.min(Number(url.searchParams.get("n") ?? "100") || 100, 1000);
  const last = url.searchParams.get("last");

  const repositories = new RepositoryStore(env.DB);
  const page = await repositories.catalog(limit, last, audienceOf(principal));

  const headers = new Headers({ "Content-Type": "application/json" });
  if (page.hasMore && page.names.length > 0) {
    const next = new URLSearchParams({ n: String(limit), last: page.names[page.names.length - 1]! });
    headers.set("Link", `</v2/_catalog?${next.toString()}>; rel="next"`);
  }

  return new Response(JSON.stringify({ repositories: page.names }), { headers });
}
