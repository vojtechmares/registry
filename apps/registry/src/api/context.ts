import type { Context, MiddlewareHandler } from "hono";
import type { RateLimitInfo } from "hono-rate-limiter";
import { AuditStore } from "../audit/store.js";
import { createAuthorize } from "../auth/authorize.js";
import { readConfig, type RegistryConfig } from "../auth/config.js";
import { ANONYMOUS, resolvePrincipal, type Principal } from "../auth/principal.js";
import { readSessionCookie, verifySessionCookie } from "../auth/session.js";
import { AuthStore } from "../auth/store.js";
import type { Env } from "../env.js";
import { NotificationStore } from "../notifications/store.js";
import { REPLICATE_TASK } from "../replication/execute.js";
import { ReplicationStore } from "../replication/store.js";
import { CleanupStore } from "../storage/cleanup.js";
import { ProjectStore } from "../storage/projects.js";
import { RepositoryStore } from "../storage/repositories.js";
import { StatsStore } from "../storage/stats.js";
import { TagIndex } from "../storage/tags.js";
import { TokenStore } from "../storage/tokens.js";
import { UserStore } from "../storage/users.js";
import { TaskQueue } from "../tasks/queue.js";

/** Where the management API lives. Also the prefix every OpenAPI path carries. */
export const PREFIX = "/api/v1";

/** Everything a route reaches for, resolved once per request. */
export interface Stores {
  readonly auth: AuthStore;
  readonly repositories: RepositoryStore;
  readonly tokens: TokenStore;
  readonly users: UserStore;
  readonly audit: AuditStore;
  readonly projects: ProjectStore;
  readonly tags: TagIndex;
  readonly stats: StatsStore;
  readonly cleanup: CleanupStore;
  readonly notifications: NotificationStore;
  readonly replication: ReplicationStore;
}

export interface ApiEnv {
  readonly Bindings: Env;
  readonly Variables: {
    readonly principal: Principal;
    readonly config: RegistryConfig;
    readonly stores: Stores;
    /** True when the request arrived over https, which decides the cookie flags. */
    readonly secure: boolean;
    /** Written by `hono-rate-limiter` under its default property name. */
    readonly rateLimit: RateLimitInfo;
  };
}

export type ApiContext = Context<ApiEnv>;
export type ApiMiddleware = MiddlewareHandler<ApiEnv>;

export const principalOf = (c: ApiContext): Principal => c.get("principal");
export const storesOf = (c: ApiContext): Stores => c.get("stores");
export const configOf = (c: ApiContext): RegistryConfig => c.get("config");

/** Authorization as the caller of this request holds it. */
export function authorizeFor(c: ApiContext) {
  return createAuthorize({ principal: principalOf(c), store: storesOf(c).auth, config: configOf(c) });
}

/**
 * A manual replication run is queued, never executed inline: the request that
 * asked for it must not wait on another registry's network.
 */
export async function enqueueReplication(c: ApiContext, ruleId: string): Promise<void> {
  await new TaskQueue(c.env.DB).enqueue({ kind: REPLICATE_TASK, payload: { ruleId } });
}

/** Builds the stores and reads the config. Runs before anything touches the database. */
export const withStores: MiddlewareHandler<ApiEnv> = async (c, next) => {
  const env = c.env;
  c.set("config", readConfig(env, c.req.raw));
  c.set("secure", new URL(c.req.url).protocol === "https:");
  c.set("stores", {
    auth: new AuthStore(env.DB),
    repositories: new RepositoryStore(env.DB),
    tokens: new TokenStore(env.DB),
    users: new UserStore(env.DB),
    audit: new AuditStore(env.DB),
    projects: new ProjectStore(env.DB),
    tags: new TagIndex(env.DB),
    stats: new StatsStore(env.DB),
    cleanup: new CleanupStore(env.DB),
    notifications: new NotificationStore(env.DB),
    replication: new ReplicationStore(env.DB, env.JWT_SECRET),
  });
  await next();
};

/**
 * Resolves the caller for the management API.
 *
 * `Authorization` wins, so a script can drive the API with a machine token. The
 * session cookie is the fallback, and exists only for the dashboard.
 */
async function resolveApiPrincipal(
  request: Request,
  auth: AuthStore,
  config: RegistryConfig,
): Promise<Principal> {
  const fromHeader = await resolvePrincipal(request, auth, config);
  if (fromHeader.kind !== "anonymous") return fromHeader;

  const cookie = readSessionCookie(request);
  if (cookie === null) return ANONYMOUS;

  const identity = await verifySessionCookie(cookie, config);
  if (identity === null) return ANONYMOUS;

  // A session outlives a disabled account only until the cookie expires, so
  // confirm the user is still active on every request.
  if (identity.id !== "bootstrap") {
    const user = await auth.findUserById(identity.id);
    if (user === null || user.disabled) return ANONYMOUS;
    return { kind: "user", identity: { id: user.id, username: user.username, isAdmin: user.isAdmin } };
  }
  return { kind: "user", identity };
}

/**
 * Authenticates the caller.
 *
 * Deliberately after the address rate limiter: checking a password runs PBKDF2
 * over 210,000 iterations, and an unbounded caller must never be able to make
 * the registry do it on repeat.
 */
export const authenticate: MiddlewareHandler<ApiEnv> = async (c, next) => {
  c.set("principal", await resolveApiPrincipal(c.req.raw, storesOf(c).auth, configOf(c)));
  await next();
};
