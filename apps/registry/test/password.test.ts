/**
 * Password hashing against the real Workers crypto runtime.
 *
 * The point of running this under `@cloudflare/vitest-pool-workers` rather than
 * plain Vitest is that the runtime enforces limits Miniflare's Node fallback
 * does not - most importantly the PBKDF2 iteration cap. A hash produced here is
 * one production will accept.
 */

import { describe, expect, it } from "vitest";
import { hashPassword, verifyPassword } from "../src/auth/password.js";

describe("password hashing", () => {
  it("round trips a password", async () => {
    const hash = await hashPassword("correct horse battery staple");
    expect(hash.startsWith("pbkdf2$")).toBe(true);
    expect(await verifyPassword("correct horse battery staple", hash)).toBe(true);
    expect(await verifyPassword("wrong password", hash)).toBe(false);
  });

  it("stays within the Workers PBKDF2 iteration cap", async () => {
    // The runtime rejects `deriveBits` above 100,000 iterations with a
    // NotSupportedError. Miniflare does not, so only a real hash here proves the
    // configured iteration count is one production can actually verify. A bump
    // past the cap fails this test rather than every login in production.
    const hash = await hashPassword("x");
    const iterations = Number(hash.split("$")[1]);
    expect(iterations).toBeLessThanOrEqual(100_000);
    expect(await verifyPassword("x", hash)).toBe(true);
  });

  it("rejects a malformed encoding rather than throwing", async () => {
    expect(await verifyPassword("x", "not-a-hash")).toBe(false);
    expect(await verifyPassword("x", "pbkdf2$abc$salt$hash")).toBe(false);
  });
});
