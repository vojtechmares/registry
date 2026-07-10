import { rateLimiter, type ClientRateLimitInfo, type Store } from "hono-rate-limiter";
import type { RateLimiterObject } from "../durable-objects/rate-limiter.js";
import { flag, integer, type Env } from "../env.js";
import { clientAddress, verifiesPassword } from "../rate-limit.js";
import type { ApiContext, ApiEnv, ApiMiddleware } from "./context.js";
import { problemResponse, rateLimited, toProblem } from "./problem.js";

const WINDOW_MS = 60_000;

/**
 * Deriving a password hash is orders of magnitude costlier than serving JSON, so
 * the requests that may do it are held to a fraction of the rate, in a bucket of
 * their own. A caller may still drive the dashboard at full speed while being
 * allowed only a fifth as many guesses at a password.
 */
const PASSWORD_COST = 5;

/**
 * Shards keys over Durable Objects so no single object becomes a global
 * chokepoint. A key always lands on the same shard, so its counter stays exact.
 */
function shardFor(key: string): string {
  let hash = 2166136261;
  for (let i = 0; i < key.length; i++) {
    hash ^= key.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }
  return `shard-${(hash >>> 0) % 16}`;
}

/**
 * `hono-rate-limiter`'s hit counter, kept in the Durable Object that already
 * meters the registry API.
 *
 * A Worker isolate is no place to count anything: the next request from the same
 * client may be served by another one, and the library's `MemoryStore` would
 * hand each isolate an allowance of its own. Counting in a Durable Object is
 * what makes one limit mean one thing across the whole deployment.
 */
export class DurableObjectStore implements Store {
  /** The counter is shared, so the library need not warn about double counting. */
  readonly localKeys = false;

  private windowMs = WINDOW_MS;

  constructor(
    private readonly namespace: DurableObjectNamespace<RateLimiterObject>,
    readonly prefix: string,
  ) {}

  init(options: { readonly windowMs: number }): void {
    this.windowMs = options.windowMs;
  }

  async increment(key: string): Promise<ClientRateLimitInfo> {
    const scoped = this.prefixKey(key);
    const { totalHits, resetAt } = await this.stub(scoped).hit(scoped, this.windowMs);
    return { totalHits, resetTime: new Date(resetAt) };
  }

  async decrement(key: string): Promise<void> {
    const scoped = this.prefixKey(key);
    await this.stub(scoped).unhit(scoped);
  }

  async resetKey(key: string): Promise<void> {
    const scoped = this.prefixKey(key);
    await this.stub(scoped).reset(scoped);
  }

  private prefixKey(key: string): string {
    return `${this.prefix}${key}`;
  }

  private stub(key: string): DurableObjectStub<RateLimiterObject> {
    return this.namespace.get(this.namespace.idFromName(shardFor(key)));
  }
}

/** Zero disables a limiter outright, which is how an operator turns one off. */
const enabled = (env: Env, perMinute: number): boolean => flag(env.RATE_LIMIT_ENABLED, true) && perMinute > 0;

/**
 * Refuses with the problem document the rest of the management API refuses with.
 *
 * The limiter answers from its own handler rather than by throwing, so this is
 * the one refusal `onError` never sees, and the one that has to render itself.
 *
 * `RateLimit-*` is already on the response when the address limiter is the one
 * refusing; `Retry-After` is set here so it is present whichever limiter bites.
 */
function refuse(c: ApiContext): Response {
  const resetTime = c.get("rateLimit")?.resetTime;
  const seconds =
    resetTime === undefined ? 60 : Math.max(1, Math.ceil((resetTime.getTime() - Date.now()) / 1000));

  const problem = rateLimited(`too many requests; retry in ${seconds} seconds`);
  return problemResponse(toProblem(problem, c.req.path), { "Retry-After": String(seconds) });
}

interface LimiterOptions {
  readonly prefix: string;
  readonly key: (c: ApiContext) => string;
  readonly limit: (env: Env) => number;
  /** Only the address limiter advertises `RateLimit-*`: it is the one that applies to everyone. */
  readonly advertise?: boolean;
  readonly skip?: (c: ApiContext) => boolean;
}

function limiter(
  namespace: DurableObjectNamespace<RateLimiterObject>,
  options: LimiterOptions,
): ApiMiddleware {
  return rateLimiter<ApiEnv>({
    store: new DurableObjectStore(namespace, options.prefix),
    windowMs: WINDOW_MS,
    standardHeaders: options.advertise === true ? "draft-6" : false,
    keyGenerator: options.key,
    limit: (c) => options.limit(c.env),
    skip: (c) => !enabled(c.env, options.limit(c.env)) || (options.skip?.(c) ?? false),
    handler: refuse,
  });
}

const addressRpm = (env: Env): number => integer(env.RATE_LIMIT_IP_RPM, 1200);

/**
 * Three limiters, guarding three different things.
 *
 * The address limiter is charged before the request is authenticated. It has to
 * be: verifying a password runs PBKDF2 over 210,000 iterations, so a caller who
 * is never limited can burn the registry's CPU at will while guessing.
 *
 * The password limiter is charged on a key of its own, and only when serving the
 * request may actually derive a hash. Every endpoint accepts `Authorization:
 * Basic`, so pricing the login route alone would leave a guesser free to hammer
 * a project listing instead. Keeping it on a separate key means a busy dashboard
 * cannot exhaust the allowance its own user needs in order to sign back in.
 *
 * The principal limiter is charged afterwards and follows a user across
 * addresses, which is what keeps one account from monopolising the registry from
 * a fleet of machines. An anonymous caller has no identity to bill, and is
 * already accounted for by their address.
 */
export function rateLimiters(env: Env): {
  /** Both charged before the caller is authenticated. */
  readonly address: ApiMiddleware;
  readonly password: ApiMiddleware;
  /** Charged after, once there is an identity to bill. */
  readonly principal: ApiMiddleware;
} {
  const namespace = env.RATE_LIMITER;

  return {
    address: limiter(namespace, {
      prefix: "api-ip:",
      key: (c) => clientAddress(c.req.raw),
      limit: addressRpm,
      advertise: true,
    }),

    password: limiter(namespace, {
      prefix: "api-pw:",
      key: (c) => clientAddress(c.req.raw),
      limit: (bindings) => Math.max(1, Math.floor(addressRpm(bindings) / PASSWORD_COST)),
      skip: (c) => !verifiesPassword(c.req.raw, c.req.path),
    }),

    principal: limiter(namespace, {
      prefix: "api-user:",
      key: (c) => {
        const caller = c.get("principal");
        return caller.kind === "anonymous" ? "anonymous" : caller.identity.id;
      },
      limit: (bindings) => integer(bindings.RATE_LIMIT_USER_RPM, 3000),
      skip: (c) => c.get("principal").kind === "anonymous",
    }),
  };
}
