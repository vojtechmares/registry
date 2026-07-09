/**
 * The OIDC sign-in flow, driven end to end against a fake provider.
 *
 * The Worker is configured for single sign-on through the pool's bindings, and
 * the provider's HTTP endpoints are intercepted with the pool's `fetchMock` -
 * which, unlike a stubbed global, reaches the `fetch` the Worker itself makes.
 * The flow's own signed cookie is carried from the start request into the
 * callback the way a browser would.
 */

import { SELF, env, fetchMock } from "cloudflare:test";
import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import { base64UrlEncode } from "@registry/oidc";
import { seedUser } from "./helpers.js";

const ISSUER = "https://idp.test";
const CLIENT_ID = "registry-client";
const BASE = "https://registry.test";

interface Signer {
  jwks: { keys: unknown[] };
  sign: (claims: Record<string, unknown>) => Promise<string>;
}

const encode = (value: unknown) => base64UrlEncode(new TextEncoder().encode(JSON.stringify(value)));

async function makeSigner(): Promise<Signer> {
  const pair = (await crypto.subtle.generateKey(
    {
      name: "RSASSA-PKCS1-v1_5",
      modulusLength: 2048,
      publicExponent: new Uint8Array([1, 0, 1]),
      hash: "SHA-256",
    },
    true,
    ["sign", "verify"],
  )) as CryptoKeyPair;

  const jwk = (await crypto.subtle.exportKey("jwk", pair.publicKey)) as unknown as Record<string, unknown>;
  const publicJwk = { ...jwk, kid: "test-key", use: "sig", alg: "RS256" };

  return {
    jwks: { keys: [publicJwk] },
    sign: async (claims) => {
      const head = encode({ alg: "RS256", kid: "test-key", typ: "JWT" });
      const body = encode(claims);
      const signature = await crypto.subtle.sign(
        "RSASSA-PKCS1-v1_5",
        pair.privateKey,
        new TextEncoder().encode(`${head}.${body}`),
      );
      return `${head}.${body}.${base64UrlEncode(new Uint8Array(signature))}`;
    },
  };
}

let signer: Signer;
/** The ID token the intercepted token endpoint will return on the next exchange. */
let pendingToken = "";

/**
 * Points the provider's three endpoints at our fake. `discover` and the JWKS
 * fetch fire on both the start and callback requests, so each is answered as
 * many times as the flow needs it.
 */
function interceptProvider(): void {
  const client = fetchMock.get(ISSUER);

  client
    .intercept({ path: "/.well-known/openid-configuration", method: "GET" })
    .reply(200, {
      issuer: ISSUER,
      authorization_endpoint: `${ISSUER}/authorize`,
      token_endpoint: `${ISSUER}/token`,
      jwks_uri: `${ISSUER}/jwks`,
    })
    .persist();

  client
    .intercept({ path: "/jwks", method: "GET" })
    .reply(200, () => signer.jwks)
    .persist();

  client
    .intercept({ path: "/token", method: "POST" })
    .reply(200, () => ({ id_token: pendingToken }))
    .persist();
}

/** Runs `/auth/oidc/start`, and returns the flow cookie plus the state and nonce it minted. */
async function begin(next?: string): Promise<{ cookie: string; state: string; nonce: string }> {
  const url =
    next === undefined ? `${BASE}/api/v1/auth/oidc/start` : `${BASE}/api/v1/auth/oidc/start?next=${next}`;
  const response = await SELF.fetch(url, { redirect: "manual" });
  expect(response.status).toBe(302);

  const location = new URL(response.headers.get("Location")!);
  const cookie = response.headers.get("Set-Cookie")!.split(";")[0]!;

  return {
    cookie,
    state: location.searchParams.get("state")!,
    nonce: location.searchParams.get("nonce")!,
  };
}

function callback(state: string, cookie: string, code = "auth-code"): Promise<Response> {
  return SELF.fetch(`${BASE}/api/v1/auth/oidc/callback?code=${code}&state=${state}`, {
    headers: { Cookie: cookie },
    redirect: "manual",
  });
}

function idToken(nonce: string, overrides: Record<string, unknown>): Promise<string> {
  return signer.sign({
    iss: ISSUER,
    aud: CLIENT_ID,
    exp: Math.floor(Date.now() / 1000) + 300,
    iat: Math.floor(Date.now() / 1000),
    nonce,
    ...overrides,
  });
}

beforeAll(async () => {
  signer = await makeSigner();
});

beforeEach(() => {
  fetchMock.activate();
  fetchMock.disableNetConnect();
  interceptProvider();
});

describe("provider discovery route", () => {
  it("advertises that single sign-on is available", async () => {
    const response = await SELF.fetch(`${BASE}/api/v1/auth/providers`);
    expect(await response.json()).toEqual({ password: true, oidc: true });
  });
});

describe("the sign-in flow", () => {
  it("provisions a new user and hands back a session", async () => {
    const started = await begin();
    pendingToken = await idToken(started.nonce, {
      sub: "google-oauth2|12345",
      email: "alice@example.com",
      preferred_username: "alice",
    });

    const response = await callback(started.state, started.cookie);
    expect(response.status).toBe(302);
    expect(response.headers.get("Location")).toBe("/");
    expect(response.headers.get("Set-Cookie") ?? "").toContain("registry_session=");

    // The provisioned account has no password anyone could guess.
    const row = await env.DB.prepare(
      "SELECT username, password_hash, oidc_issuer FROM users WHERE oidc_subject = ?",
    )
      .bind("google-oauth2|12345")
      .first<{ username: string; password_hash: string; oidc_issuer: string }>();
    expect(row?.username).toBe("alice");
    expect(row?.password_hash).toBe("external:oidc");
    expect(row?.oidc_issuer).toBe(ISSUER);
  });

  it("reuses the account on a second sign-in rather than making another", async () => {
    const subject = `repeat|${crypto.randomUUID()}`;
    for (let i = 0; i < 2; i++) {
      const started = await begin();
      pendingToken = await idToken(started.nonce, { sub: subject, preferred_username: "bob" });
      expect((await callback(started.state, started.cookie)).status).toBe(302);
    }

    const count = await env.DB.prepare("SELECT COUNT(*) AS n FROM users WHERE oidc_subject = ?")
      .bind(subject)
      .first<{ n: number }>();
    expect(count?.n).toBe(1);
  });

  it("gives a second identity a distinct username when the first is taken", async () => {
    await seedUser({ id: "human-carol", username: "carol", password: "correct-horse-battery" });

    const started = await begin();
    pendingToken = await idToken(started.nonce, {
      sub: `carol-oidc|${crypto.randomUUID()}`,
      preferred_username: "carol",
    });
    await callback(started.state, started.cookie);

    const usernames = await env.DB.prepare("SELECT username FROM users WHERE username LIKE 'carol%'").all<{
      username: string;
    }>();
    expect(usernames.results.map((row) => row.username)).toContain("carol-2");
  });

  it("makes a user an administrator when their groups say so", async () => {
    const started = await begin();
    pendingToken = await idToken(started.nonce, {
      sub: `admin|${crypto.randomUUID()}`,
      preferred_username: "dana",
      groups: ["platform-admins"],
    });
    await callback(started.state, started.cookie);

    const row = await env.DB.prepare("SELECT is_admin FROM users WHERE username = 'dana'").first<{
      is_admin: number;
    }>();
    expect(row?.is_admin).toBe(1);
  });

  it("sends the user to a safe `next` path after signing in", async () => {
    const started = await begin("/admin");
    pendingToken = await idToken(started.nonce, {
      sub: `next|${crypto.randomUUID()}`,
      preferred_username: "finn",
    });
    const response = await callback(started.state, started.cookie);
    expect(response.headers.get("Location")).toBe("/admin");
  });

  it("ignores a `next` that points off-origin", async () => {
    const started = await begin("https://evil.test");
    pendingToken = await idToken(started.nonce, {
      sub: `evil|${crypto.randomUUID()}`,
      preferred_username: "gwen",
    });
    const response = await callback(started.state, started.cookie);
    expect(response.headers.get("Location")).toBe("/");
  });

  it("refuses a callback whose state does not match the flow", async () => {
    const started = await begin();
    const response = await callback("forged-state", started.cookie);
    expect(response.headers.get("Location")).toContain("/login?error=");
  });

  it("refuses a callback with no flow cookie", async () => {
    const started = await begin();
    const response = await SELF.fetch(`${BASE}/api/v1/auth/oidc/callback?code=x&state=${started.state}`, {
      redirect: "manual",
    });
    expect(response.headers.get("Location")).toContain("/login?error=");
  });

  it("refuses a token whose nonce does not match", async () => {
    const started = await begin();
    pendingToken = await idToken("not-the-nonce-we-issued", {
      sub: "nonce-mismatch",
      preferred_username: "eve",
    });
    const response = await callback(started.state, started.cookie);
    expect(response.headers.get("Location")).toContain("/login?error=");
  });

  it("passes an error from the provider back to the sign-in page", async () => {
    const started = await begin();
    const response = await SELF.fetch(
      `${BASE}/api/v1/auth/oidc/callback?error=access_denied&state=${started.state}`,
      { headers: { Cookie: started.cookie }, redirect: "manual" },
    );
    expect(response.headers.get("Location")).toContain("access_denied");
  });
});
