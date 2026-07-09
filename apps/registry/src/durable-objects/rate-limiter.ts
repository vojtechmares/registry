import { DurableObject } from "cloudflare:workers";
import type { Env } from "../env.js";

export interface RateLimitResult {
  readonly allowed: boolean;
  /** Seconds until the next request would be admitted. Zero when allowed. */
  readonly retryAfter: number;
  readonly remaining: number;
}

interface Bucket {
  tokens: number;
  updatedAt: number;
}

/**
 * A token bucket per principal.
 *
 * State lives in memory only. A Durable Object may be evicted, which resets the
 * bucket and briefly lets a client through - the tradeoff for never paying a
 * storage write on the hot path of every pull. Rate limiting is a guard against
 * abuse, not an accounting ledger, so failing open on eviction is the right side
 * to err on.
 */
export class RateLimiterObject extends DurableObject<Env> {
  private readonly buckets = new Map<string, Bucket>();

  override async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    const key = url.searchParams.get("key") ?? "";
    const capacity = Number(url.searchParams.get("capacity") ?? "60");
    const refillPerSecond = Number(url.searchParams.get("refill") ?? "1");
    const cost = Number(url.searchParams.get("cost") ?? "1");

    return Response.json(this.consume(key, capacity, refillPerSecond, cost));
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

  /** Drops buckets that have refilled completely; they carry no information. */
  private sweep(now: number): void {
    if (this.buckets.size < 1000) return;
    for (const [key, bucket] of this.buckets) {
      if (now - bucket.updatedAt > 10 * 60 * 1000) this.buckets.delete(key);
    }
  }
}
