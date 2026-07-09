import { OciError } from "@registry/oci";
import { errorResponse, handleRegistryRequest, type RegistryContext } from "@registry/registry-core";
import { createAuthorize } from "./auth/authorize.js";
import { readConfig } from "./auth/config.js";
import { resolvePrincipal, type Principal } from "./auth/principal.js";
import { AuthStore } from "./auth/store.js";
import { readCoreConfig, type Env } from "./env.js";
import { EventCollector } from "./events.js";
import { runDueCleanups } from "./lifecycle/cleanup.js";
import { collectGarbage } from "./lifecycle/garbage-collector.js";
import { runLifecycle } from "./lifecycle/policies.js";
import { NOTIFY_TASK, handleNotifyTask, notify } from "./notifications/dispatch.js";
import { dedupe, toNotificationEvent } from "./notifications/translate.js";
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
import { TaskQueue } from "./tasks/queue.js";
import { sweepTasks, type TaskHandler } from "./tasks/runner.js";

export { RateLimiterObject } from "./durable-objects/rate-limiter.js";
export { UploadSessionObject } from "./durable-objects/upload-session.js";

function notFound(): Response {
  return Response.json({ errors: [{ code: "UNSUPPORTED", message: "not found" }] }, { status: 404 });
}

/** Must match `triggers.crons` in wrangler.jsonc. */
const NIGHTLY_CRON = "17 3 * * *";

/** Finished tasks are kept for a week, long enough to explain a failure. */
const TASK_RETENTION_MS = 7 * 86_400_000;

/** Every kind of background work the queue knows how to run. */
const TASK_HANDLERS: Readonly<Record<string, TaskHandler>> = {
  [NOTIFY_TASK]: handleNotifyTask,
};

async function nightlyMaintenance(env: Env): Promise<void> {
  const retired = await runLifecycle(env);
  const reclaimed = await collectGarbage(env);
  const pruned = await new StatsStore(env.DB).prune();
  const tasks = await new TaskQueue(env.DB).prune(TASK_RETENTION_MS);
  console.log("nightly maintenance complete", { retired, reclaimed, pruned, tasks });
}

/**
 * The frequent trigger. Runs the cleanup policies that have come due, then
 * drains whatever background work is waiting - retried notifications, mostly,
 * since a fresh one is delivered from the request that caused it.
 */
async function sweepSchedules(env: Env): Promise<void> {
  const cleanups = await runDueCleanups(env);
  if (cleanups.length > 0) console.log("cleanup policies run", cleanups);

  const tasks = await sweepTasks(env, TASK_HANDLERS);
  if (tasks.ran > 0) console.log("background tasks run", tasks);
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
   * Two schedules, doing very different amounts of work.
   *
   * The frequent one only asks which project cleanup policies have come due, so
   * that a project's own cron expression is honoured to within a quarter hour.
   * The nightly one retires content and then reclaims it - in that order, so a
   * single run collects what it has just retired - and prunes old counters.
   */
  async scheduled(event: ScheduledController, env: Env, ctx: ExecutionContext): Promise<void> {
    ctx.waitUntil(event.cron === NIGHTLY_CRON ? nightlyMaintenance(env) : sweepSchedules(env));
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
  if (events.events.length > 0) ctx.waitUntil(recordEvents(env, ctx, events, principal));

  return response ?? notFound();
}

/**
 * Counts what happened, and tells whoever asked to be told.
 *
 * Both after the response has gone out, and both swallowing their own failures:
 * a registry that cannot count, or whose webhook endpoint is down, must still
 * be a registry that serves.
 */
async function recordEvents(
  env: Env,
  ctx: ExecutionContext,
  events: EventCollector,
  principal: Principal,
): Promise<void> {
  try {
    await new StatsStore(env.DB).record(events.events);
  } catch (error) {
    console.error("failed to record usage", error);
  }

  const actor = { username: principal.kind === "anonymous" ? "anonymous" : principal.identity.username };
  const notifications = dedupe(
    events.events.flatMap((event) => {
      const translated = toNotificationEvent(event, actor);
      return translated === null ? [] : [translated];
    }),
  );

  for (const event of notifications) {
    try {
      const queued = await notify(env, event);
      // Deliver now rather than waiting up to fifteen minutes for the sweep.
      if (queued > 0) ctx.waitUntil(sweepTasks(env, TASK_HANDLERS));
    } catch (error) {
      console.error("failed to queue notifications", error);
    }
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
