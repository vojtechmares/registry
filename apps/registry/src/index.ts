import { OciError } from "@registry/oci";
import { errorResponse, handleRegistryRequest, type RegistryContext } from "@registry/registry-core";
import { createAuthorize } from "./auth/authorize.js";
import { readConfig } from "./auth/config.js";
import { resolvePrincipal, type Principal } from "./auth/principal.js";
import { AuthStore } from "./auth/store.js";
import { readCoreConfig, type Env } from "./env.js";
import { EventCollector } from "./events.js";
import { collectGarbage } from "./lifecycle/garbage-collector.js";
import { runLifecycle } from "./lifecycle/policies.js";
import { ProjectPolicy } from "./policy.js";
import { enforceAddressRateLimit, enforcePrincipalRateLimit } from "./rate-limit.js";
import { handleApiRequest, handleCatalog } from "./routes/api.js";
import { handleToken } from "./routes/token.js";
import { R2ContentStore } from "./storage/content.js";
import { D1MetadataStore } from "./storage/metadata.js";
import { ProjectStore } from "./storage/projects.js";
import { SignatureIndex } from "./storage/signatures.js";
import { StatsStore } from "./storage/stats.js";
import { DurableObjectUploadStore } from "./storage/uploads.js";

export { RateLimiterObject } from "./durable-objects/rate-limiter.js";
export { UploadSessionObject } from "./durable-objects/upload-session.js";

function notFound(): Response {
  return Response.json({ errors: [{ code: "UNSUPPORTED", message: "not found" }] }, { status: 404 });
}

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    try {
      return await route(request, env, ctx);
    } catch (error) {
      if (error instanceof OciError) return errorResponse(error);
      console.error("unhandled error", error);
      return Response.json(
        { errors: [{ code: "UNSUPPORTED", message: "internal server error" }] },
        { status: 500 },
      );
    }
  },

  /**
   * Nightly maintenance. Lifecycle policies retire content first, then garbage
   * collection reclaims whatever no longer has a referrer - in that order, so a
   * single run reclaims what it just retired.
   */
  async scheduled(_event: ScheduledController, env: Env, ctx: ExecutionContext): Promise<void> {
    ctx.waitUntil(
      (async () => {
        const retired = await runLifecycle(env);
        const reclaimed = await collectGarbage(env);
        const pruned = await new StatsStore(env.DB).prune();
        console.log("maintenance complete", { retired, reclaimed, pruned });
      })(),
    );
  },
} satisfies ExportedHandler<Env>;

async function route(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
  const url = new URL(request.url);

  if (url.pathname === "/healthz") return new Response("ok", { headers: { "Content-Type": "text/plain" } });

  const config = readConfig(env, request);
  if (config.jwtSecret === "") throw new Error("JWT_SECRET is not configured");

  if (url.pathname.startsWith("/api/")) {
    await enforceAddressRateLimit(env, request, url.pathname);
    const response = await handleApiRequest(request, env, config);
    return response ?? notFound();
  }

  // Anything that is neither the registry nor the management API is the
  // dashboard, served from the bundled static assets.
  if (!url.pathname.startsWith("/v2")) return serveAssets(request, env);

  const isTokenEndpoint = url.pathname === "/v2/token";

  // Before authenticating, not after: checking a password is the most expensive
  // thing this Worker does, and an unbounded caller must never be able to make
  // us do it on repeat.
  await enforceAddressRateLimit(env, request, url.pathname);

  const store = new AuthStore(env.DB);
  const principal = await resolvePrincipal(request, store, config);

  await enforcePrincipalRateLimit(env, principal);

  // The token endpoint sits inside /v2 but outside the distribution API: it is
  // where a client goes *because* it was refused, so it cannot be gated by the
  // same authorization it is trying to satisfy.
  if (isTokenEndpoint) return handleToken(request, principal, store, config);

  if (url.pathname === "/v2/_catalog") {
    return handleCatalog(request, env, principal, createAuthorize({ principal, store, config }));
  }

  // The counters are written after the response is on its way. A registry that
  // cannot count must still be able to serve, and a `docker pull` must never
  // wait on a statistic.
  const events = new EventCollector();
  const response = await handleRegistryRequest(
    request,
    registryContext(env, principal, store, request, events),
  );
  if (events.events.length > 0) ctx.waitUntil(recordEvents(env, events));

  return response ?? notFound();
}

async function recordEvents(env: Env, events: EventCollector): Promise<void> {
  try {
    await new StatsStore(env.DB).record(events.events);
  } catch (error) {
    // Losing a counter is not worth an unhandled rejection in the isolate.
    console.error("failed to record usage", error);
  }
}

/**
 * Serves the dashboard. Unknown paths fall back to `index.html` so the
 * client-side router owns them, which `not_found_handling` in wrangler.jsonc
 * already arranges; this only guards the case where no assets are bound.
 */
async function serveAssets(request: Request, env: Env): Promise<Response> {
  if (env.ASSETS === undefined) return notFound();
  return env.ASSETS.fetch(request);
}

function registryContext(
  env: Env,
  principal: Principal,
  store: AuthStore,
  request: Request,
  events: EventCollector,
): RegistryContext {
  return {
    metadata: new D1MetadataStore(env.DB),
    content: new R2ContentStore(env.BUCKET),
    uploads: new DurableObjectUploadStore(env.UPLOAD_SESSION),
    config: readCoreConfig(env),
    authorize: createAuthorize({ principal, store, config: readConfig(env, request) }),
    policy: new ProjectPolicy(new ProjectStore(env.DB), new SignatureIndex(env.DB)),
    events,
  };
}
