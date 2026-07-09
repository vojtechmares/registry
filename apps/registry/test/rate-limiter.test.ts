/**
 * The token-bucket Durable Object, driven directly. The middleware that charges
 * it is disabled for the rest of the suite, so this is where the limiter's own
 * behaviour - admit up to capacity, then refuse with a retry hint - is pinned.
 */

import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";

interface RateLimitResult {
  readonly allowed: boolean;
  readonly retryAfter: number;
  readonly remaining: number;
}

async function consume(key: string, capacity: number, refill: number): Promise<RateLimitResult> {
  const stub = env.RATE_LIMITER.get(env.RATE_LIMITER.idFromName("shard"));
  const url = `https://rate-limiter.internal/consume?key=${key}&capacity=${capacity}&refill=${refill}&cost=1`;
  const response = await stub.fetch(url, { method: "POST" });
  return response.json<RateLimitResult>();
}

describe("rate limiter durable object", () => {
  it("admits up to capacity, then refuses with a positive retry-after", async () => {
    // A slow refill keeps the bucket from topping up within the test, so the
    // fourth request against a capacity of three is decided by capacity alone.
    const capacity = 3;
    const refill = 0.05;

    for (let i = 1; i <= capacity; i++) {
      const result = await consume("client-a", capacity, refill);
      expect(result.allowed, `request ${i}`).toBe(true);
      expect(result.remaining, `request ${i}`).toBe(capacity - i);
    }

    const rejected = await consume("client-a", capacity, refill);
    expect(rejected.allowed).toBe(false);
    expect(rejected.remaining).toBe(0);
    // The client is told how long to wait rather than being left to guess.
    expect(rejected.retryAfter).toBeGreaterThan(0);
  });

  it("meters each key independently", async () => {
    // A key that has never been seen starts with a full bucket, so one client
    // exhausting its allowance cannot spend another's.
    for (let i = 0; i < 3; i++) await consume("client-b", 3, 0.05);
    expect((await consume("client-b", 3, 0.05)).allowed).toBe(false);

    const fresh = await consume("client-c", 3, 0.05);
    expect(fresh.allowed).toBe(true);
    expect(fresh.remaining).toBe(2);
  });
});
