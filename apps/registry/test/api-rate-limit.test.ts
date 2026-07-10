/**
 * The management API's rate limiters, driven through the Hono app itself.
 *
 * The rest of the suite runs with `RATE_LIMIT_ENABLED=false`, so the app is
 * rebuilt here over bindings of our own rather than by mutating the ones every
 * other test file shares. The Durable Object behind it is the real one, and its
 * counters live in memory for the lifetime of the runtime - so every test picks
 * an address nobody else has used.
 */

import { createExecutionContext, env, waitOnExecutionContext } from "cloudflare:test";
import { beforeAll, describe, expect, it } from "vitest";
import { apiApp } from "../src/api/app.js";
import type { Env } from "../src/env.js";
import { basic, seedUser } from "./helpers.js";

const USER = { id: "rl-root", username: "rlroot", password: "correct-horse-battery" };

beforeAll(async () => {
  await seedUser(USER);
});

/** Fresh bindings mean a fresh app: `apiApp` caches one per binding object. */
function bindings(overrides: Partial<Record<string, string>>): Env {
  return { ...env, RATE_LIMIT_ENABLED: "true", ...overrides } as unknown as Env;
}

async function get(
  worker: Env,
  path: string,
  address: string,
  headers: Record<string, string> = {},
): Promise<Response> {
  const ctx = createExecutionContext();
  const request = new Request(`https://registry.test${path}`, {
    headers: { "CF-Connecting-IP": address, ...headers },
  });
  const response = await apiApp(worker).fetch(request, worker, ctx);
  await waitOnExecutionContext(ctx);
  return response;
}

async function post(worker: Env, path: string, address: string, body: unknown): Promise<Response> {
  const ctx = createExecutionContext();
  const request = new Request(`https://registry.test${path}`, {
    method: "POST",
    headers: { "CF-Connecting-IP": address, "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  const response = await apiApp(worker).fetch(request, worker, ctx);
  await waitOnExecutionContext(ctx);
  return response;
}

describe("the address limiter", () => {
  it("admits up to the limit, then refuses with a Retry-After", async () => {
    const worker = bindings({ RATE_LIMIT_IP_RPM: "5" });
    const address = "203.0.113.1";

    for (let i = 1; i <= 5; i++) {
      const response = await get(worker, "/api/v1/auth/providers", address);
      expect(response.status, `request ${i}`).toBe(200);
    }

    const refused = await get(worker, "/api/v1/auth/providers", address);
    expect(refused.status).toBe(429);
    expect(Number(refused.headers.get("Retry-After"))).toBeGreaterThan(0);

    const body = (await refused.json()) as { error: string; message: string };
    expect(body.error).toBe("rate_limited");
    expect(body.message).toContain("retry in");
  });

  it("meters each address on its own budget", async () => {
    const worker = bindings({ RATE_LIMIT_IP_RPM: "2" });

    for (let i = 0; i < 2; i++)
      expect((await get(worker, "/api/v1/auth/providers", "203.0.113.2")).status).toBe(200);
    expect((await get(worker, "/api/v1/auth/providers", "203.0.113.2")).status).toBe(429);

    // A neighbour who has spent nothing is unaffected.
    expect((await get(worker, "/api/v1/auth/providers", "203.0.113.3")).status).toBe(200);
  });

  it("advertises what is left", async () => {
    const worker = bindings({ RATE_LIMIT_IP_RPM: "10" });
    const response = await get(worker, "/api/v1/auth/providers", "203.0.113.4");

    expect(response.headers.get("RateLimit-Limit")).toBe("10");
    expect(response.headers.get("RateLimit-Remaining")).toBe("9");
    expect(Number(response.headers.get("RateLimit-Reset"))).toBeGreaterThan(0);
  });

  it("is off when the operator turns it off", async () => {
    const worker = { ...env, RATE_LIMIT_ENABLED: "false", RATE_LIMIT_IP_RPM: "1" } as unknown as Env;
    for (let i = 0; i < 4; i++) {
      expect((await get(worker, "/api/v1/auth/providers", "203.0.113.5")).status).toBe(200);
    }
  });

  it("treats a limit of zero as no limit, which is how a bucket is disabled", async () => {
    const worker = bindings({ RATE_LIMIT_IP_RPM: "0" });
    for (let i = 0; i < 4; i++) {
      expect((await get(worker, "/api/v1/auth/providers", "203.0.113.6")).status).toBe(200);
    }
  });
});

/**
 * Deriving a password hash is orders of magnitude costlier than serving JSON, so
 * the requests that may do it are held to a fifth of the address rate, on a key
 * of their own - a busy dashboard must not exhaust the allowance its own user
 * needs in order to sign back in.
 */
describe("the password limiter", () => {
  it("cuts a signing-in caller off long before the address budget is spent", async () => {
    const worker = bindings({ RATE_LIMIT_IP_RPM: "10" });
    const address = "203.0.113.10";
    const credentials = { username: USER.username, password: "wrong-password-entirely" };

    // Ten per minute for the address, so two for a password: `floor(10 / 5)`.
    for (let i = 1; i <= 2; i++) {
      const response = await post(worker, "/api/v1/auth/login", address, credentials);
      expect(response.status, `attempt ${i}`).toBe(401);
    }

    const refused = await post(worker, "/api/v1/auth/login", address, credentials);
    expect(refused.status).toBe(429);
  });

  it("leaves the address budget for everything else", async () => {
    const worker = bindings({ RATE_LIMIT_IP_RPM: "10" });
    const address = "203.0.113.11";

    for (let i = 0; i < 3; i++) {
      await post(worker, "/api/v1/auth/login", address, { username: "nobody", password: "x".repeat(20) });
    }

    // Three requests spent against an address budget of ten. A page load still works.
    expect((await get(worker, "/api/v1/auth/providers", address)).status).toBe(200);
  });

  it("prices a Basic header the same as the login route, wherever it is sent", async () => {
    // Every endpoint accepts `Authorization: Basic`, so pricing only the login
    // route would leave a guesser free to hammer a project listing instead.
    const worker = bindings({ RATE_LIMIT_IP_RPM: "5" });
    const address = "203.0.113.12";
    const header = { Authorization: basic(USER.username, USER.password) };

    expect((await get(worker, "/api/v1/projects", address, header)).status).toBe(200);
    const refused = await get(worker, "/api/v1/projects", address, header);
    expect(refused.status).toBe(429);
  });
});

/**
 * Charged after authentication, and keyed on the account rather than the
 * address, which is what keeps one user from monopolising the registry from a
 * fleet of machines.
 */
describe("the principal limiter", () => {
  it("follows a user across addresses", async () => {
    const worker = bindings({ RATE_LIMIT_IP_RPM: "1000", RATE_LIMIT_USER_RPM: "2" });
    const header = { Authorization: basic(USER.username, USER.password) };

    expect((await get(worker, "/api/v1/projects", "203.0.113.20", header)).status).toBe(200);
    expect((await get(worker, "/api/v1/projects", "203.0.113.21", header)).status).toBe(200);

    // A third address, the same account, and nothing left to spend.
    const refused = await get(worker, "/api/v1/projects", "203.0.113.22", header);
    expect(refused.status).toBe(429);
  });

  it("does not bill an anonymous caller, who has no identity to bill", async () => {
    const worker = bindings({ RATE_LIMIT_IP_RPM: "1000", RATE_LIMIT_USER_RPM: "1" });

    for (let i = 0; i < 4; i++) {
      expect((await get(worker, "/api/v1/auth/providers", "203.0.113.30")).status).toBe(200);
    }
  });
});
