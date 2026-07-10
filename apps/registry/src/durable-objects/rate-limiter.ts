import { DurableObject } from "cloudflare:workers";
import type { Env } from "../env.js";

export interface RateLimitResult {
  readonly allowed: boolean;
  /** Seconds until the next request would be admitted. Zero when allowed. */
  readonly retryAfter: number;
  readonly remaining: number;
}

/** What a fixed window knows about one client: how many hits, and when it rolls over. */
export interface WindowResult {
  readonly totalHits: number;
  /** Epoch milliseconds. The counter is back at zero from this instant. */
  readonly resetAt: number;
}

interface Bucket {
  tokens: number;
  updatedAt: number;
}

interface Window {
  hits: number;
  resetAt: number;
}

/** Buckets and windows are dropped once they can no longer refuse anything. */
const IDLE_MS = 10 * 60 * 1000;
const SWEEP_AT = 1000;

/**
 * Two ways of counting, for the two planes.
 *
 * The registry API - `docker pull`, `docker push` - is metered by a token
 * bucket, because a push is naturally bursty and a client that has been quiet
 * for a minute should be allowed to spend that minute at once.
 *
 * The management API is metered by `hono-rate-limiter`, whose `Store` counts
 * hits inside a fixed window. Rather than bend one algorithm into the other,
 * both live here: they share this object's lifetime, its sweep, and the shard
 * that routes a key to it.
 *
 * State lives in memory only. A Durable Object may be evicted, which resets the
 * counters and briefly lets a client through - the tradeoff for never paying a
 * storage write on the hot path of every pull. Rate limiting is a guard against
 * abuse, not an accounting ledger, so failing open on eviction is the right side
 * to err on.
 */
export class RateLimiterObject extends DurableObject<Env> {
  private readonly buckets = new Map<string, Bucket>();
  private readonly windows = new Map<string, Window>();

  override async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    const key = url.searchParams.get("key") ?? "";
    const capacity = Number(url.searchParams.get("capacity") ?? "60");
    const refillPerSecond = Number(url.searchParams.get("refill") ?? "1");
    const cost = Number(url.searchParams.get("cost") ?? "1");

    return Response.json(this.consume(key, capacity, refillPerSecond, cost));
  }

  /**
   * Counts one hit against `key` and says how many the window has seen.
   *
   * The middleware, not this object, decides what the limit is - so a request
   * that costs more can be held to a lower one without the counter having to
   * know why.
   */
  hit(key: string, windowMs: number): WindowResult {
    const now = Date.now();
    const existing = this.windows.get(key);
    const window =
      existing === undefined || existing.resetAt <= now ? { hits: 0, resetAt: now + windowMs } : existing;

    window.hits += 1;
    this.windows.set(key, window);
    this.sweep(now);
    return { totalHits: window.hits, resetAt: window.resetAt };
  }

  /** Gives a hit back, for the requests a limiter is configured not to count. */
  unhit(key: string): void {
    const window = this.windows.get(key);
    if (window !== undefined && window.hits > 0) window.hits -= 1;
  }

  reset(key: string): void {
    this.windows.delete(key);
  }

  private consume(key: string, capacity: number, refillPerSecond: number, cost: number): RateLimitResult {
    const now = Date.now();
    const bucket = this.buckets.get(key) ?? { tokens: capacity, updatedAt: now };

    const elapsedSeconds = Math.max(0, now - bucket.updatedAt) / 1000;
    bucket.tokens = Math.min(capacity, bucket.tokens + elapsedSeconds * refillPerSecond);
    bucket.updatedAt = now;

    if (bucket.tokens < cost) {
      const deficit = cost - bucket.tokens;
      this.buckets.set(key, bucket);
      this.sweep(now);
      return { allowed: false, retryAfter: Math.max(1, Math.ceil(deficit / refillPerSecond)), remaining: 0 };
    }

    bucket.tokens -= cost;
    this.buckets.set(key, bucket);
    this.sweep(now);
    return { allowed: true, retryAfter: 0, remaining: Math.floor(bucket.tokens) };
  }

  /** Drops buckets that have refilled completely, and windows that have rolled over. */
  private sweep(now: number): void {
    if (this.buckets.size >= SWEEP_AT) {
      for (const [key, bucket] of this.buckets) {
        if (now - bucket.updatedAt > IDLE_MS) this.buckets.delete(key);
      }
    }
    if (this.windows.size >= SWEEP_AT) {
      for (const [key, window] of this.windows) {
        if (window.resetAt <= now) this.windows.delete(key);
      }
    }
  }
}
