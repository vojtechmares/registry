import { tooManyRequests } from "@registry/oci";
import { TOKEN_PREFIX } from "./auth/password.js";
import type { Principal } from "./auth/principal.js";
import type { RateLimitResult } from "./durable-objects/rate-limiter.js";
import { flag, integer, type Env } from "./env.js";

const ORIGIN = "https://rate-limiter.internal";

/**
 * Two buckets guard different things.
 *
 * The address bucket is charged before the request is even authenticated. It
 * has to be: verifying a password runs PBKDF2 over 210,000 iterations, so an
 * unauthenticated caller who is never rate limited can burn the registry's CPU
 * at will while brute-forcing. This bucket is the only thing standing between a
 * password guesser and unbounded work.
 *
 * The principal bucket is charged afterwards and follows a user across
 * addresses, which is what keeps one account from monopolising the registry
 * from a fleet of machines.
 */

/** Deriving a password hash is orders of magnitude costlier than serving a blob. */
const PASSWORD_COST = 5;

/** Endpoints that take a password from the request body rather than a header. */
const PASSWORD_ENDPOINTS = new Set(["/v2/token", "/api/v1/auth/login"]);

function clientAddress(request: Request): string {
  return request.headers.get("CF-Connecting-IP") ?? "unknown";
}

/**
 * True when serving this request may run PBKDF2.
 *
 * Every endpoint accepts `Authorization: Basic`, so pricing only the token
 * endpoint would leave an attacker free to guess passwords against, say, a tag
 * listing - one rate-limit token spent, 210,000 iterations of ours burned.
 *
 * A machine token is recognisable without decoding it further and is verified
 * with a single SHA-256, so it keeps the ordinary price. So does a bearer token,
 * which costs one HMAC.
 */
export function verifiesPassword(request: Request, pathname: string): boolean {
  if (PASSWORD_ENDPOINTS.has(pathname)) return true;

  const header = request.headers.get("Authorization");
  if (header === null) return false;

  const [scheme = "", credentials = ""] = header.split(" ");
  if (scheme.toLowerCase() !== "basic") return false;

  try {
    const decoded = atob(credentials.trim());
    const separator = decoded.indexOf(":");
    // Credentials without a colon are rejected before any hash is derived.
    if (separator === -1) return false;
    return !decoded.slice(separator + 1).startsWith(TOKEN_PREFIX);
  } catch {
    // Undecodable credentials never reach PBKDF2 either.
    return false;
  }
}

/**
 * Shards buckets over Durable Objects so no single object becomes a global
 * chokepoint. A key always lands on the same shard, so its bucket stays exact.
 */
function shardFor(key: string): string {
  let hash = 2166136261;
  for (let i = 0; i < key.length; i++) {
    hash ^= key.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }
  return `shard-${(hash >>> 0) % 16}`;
}

async function consume(env: Env, key: string, perMinute: number, cost: number): Promise<void> {
  const stub = env.RATE_LIMITER.get(env.RATE_LIMITER.idFromName(shardFor(key)));

  const url = new URL("/consume", ORIGIN);
  url.searchParams.set("key", key);
  // Capacity equals the per-minute rate, so a client may spend a minute's worth
  // at once. A container push is naturally bursty and should not be throttled.
  url.searchParams.set("capacity", String(perMinute));
  url.searchParams.set("refill", String(perMinute / 60));
  url.searchParams.set("cost", String(cost));

  const response = await stub.fetch(url.toString(), { method: "POST" });
  const result = await response.json<RateLimitResult>();
  if (!result.allowed) throw tooManyRequests(result.retryAfter);
}

/** Charged before authentication, so credential checking itself is bounded. */
export async function enforceAddressRateLimit(env: Env, request: Request, pathname: string): Promise<void> {
  if (!flag(env.RATE_LIMIT_ENABLED, true)) return;

  const perMinute = integer(env.RATE_LIMIT_IP_RPM, 1200);
  if (perMinute === 0) return;

  const cost = verifiesPassword(request, pathname) ? PASSWORD_COST : 1;
  await consume(env, `ip:${clientAddress(request)}`, perMinute, cost);
}

/**
 * Charged after authentication. Anonymous callers are already accounted for by
 * their address, and have no identity to bill.
 */
export async function enforcePrincipalRateLimit(env: Env, principal: Principal): Promise<void> {
  if (!flag(env.RATE_LIMIT_ENABLED, true)) return;
  if (principal.kind === "anonymous") return;

  const perMinute = integer(env.RATE_LIMIT_USER_RPM, 3000);
  if (perMinute === 0) return;

  await consume(env, `user:${principal.identity.id}`, perMinute, 1);
}
