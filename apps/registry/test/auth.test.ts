/**
 * Authentication against the real D1-backed principal store: passwords verified
 * with genuine PBKDF2 hashes, machine tokens matched by their hashed secret, and
 * the scope confinement that keeps a narrow token narrow.
 */

import { env } from "cloudflare:test";
import { beforeAll, describe, expect, it } from "vitest";
import { formatAccessToken, hashTokenSecret } from "../src/auth/password.js";
import type { Scope } from "../src/auth/scopes.js";
import { basic, call, errorCode, seedRepository, seedUser } from "./helpers.js";

const USER = "alice";
const PASSWORD = "alice-password-1234";
const REPO = "alice/app";

// A pull-only machine token owned by alice, plus a revoked one, both minted here
// so the tests exercise the stored-secret path rather than the token endpoint.
const PULL_SECRET = "pull-token-secret-value";
const REVOKED_SECRET = "revoked-token-secret-value";
let pullToken: string;
let revokedToken: string;

async function seedToken(options: {
  id: string;
  secret: string;
  scopes: Scope[];
  revoked: boolean;
}): Promise<string> {
  const now = Date.now();
  await env.DB.prepare(
    `INSERT INTO access_tokens (id, name, user_id, secret_hash, scopes, expires_at, revoked, created_at)
     VALUES (?, ?, ?, ?, ?, NULL, ?, ?)`,
  )
    .bind(
      options.id,
      options.id,
      "alice-id",
      await hashTokenSecret(options.secret),
      JSON.stringify(options.scopes),
      options.revoked ? 1 : 0,
      now,
    )
    .run();
  return formatAccessToken(options.id, options.secret);
}

beforeAll(async () => {
  await seedUser({ id: "alice-id", username: USER, password: PASSWORD });

  await seedRepository(REPO);

  const now = Date.now();
  await env.DB.prepare(
    "INSERT INTO tags (repository, name, manifest_digest, created_at, updated_at) VALUES (?, 'v1', ?, ?, ?)",
  )
    .bind(REPO, "sha256:" + "a".repeat(64), now, now)
    .run();

  pullToken = await seedToken({
    id: "pulltoken00000001",
    secret: PULL_SECRET,
    scopes: [{ repository: REPO, actions: ["pull"] }],
    revoked: false,
  });
  revokedToken = await seedToken({
    id: "revoked0000000001",
    secret: REVOKED_SECRET,
    scopes: [{ repository: REPO, actions: ["pull"] }],
    revoked: true,
  });
});

describe("password credentials", () => {
  it("authorizes a push for the owning user with the correct password", async () => {
    // alice owns everything under `alice/`, so a valid password is enough to open
    // an upload session, which an anonymous caller could never do.
    const response = await call("POST", `/v2/${REPO}/blobs/uploads/`, {
      headers: { Authorization: basic(USER, PASSWORD) },
    });
    expect(response.status).toBe(202);
    expect(response.headers.get("Range")).toBe("0-0");
  });

  it("rejects the wrong password with 401 rather than a silent downgrade", async () => {
    const response = await call("POST", `/v2/${REPO}/blobs/uploads/`, {
      headers: { Authorization: basic(USER, "not-the-password") },
    });
    expect(response.status).toBe(401);
    expect(await errorCode(response)).toBe("UNAUTHORIZED");
  });
});

describe("machine token scope confinement", () => {
  it("allows a pull-scoped token to list tags it may read", async () => {
    const response = await call("GET", `/v2/${REPO}/tags/list`, {
      headers: { Authorization: basic("robot", pullToken) },
    });
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ name: REPO, tags: ["v1"] });
  });

  it("forbids the same token from starting a push with 403", async () => {
    // The token's owner could push here, but the token is scoped to pull only,
    // and the scope caps the owner's rights rather than the other way round.
    const response = await call("POST", `/v2/${REPO}/blobs/uploads/`, {
      headers: { Authorization: basic("robot", pullToken) },
    });
    expect(response.status).toBe(403);
    expect(await errorCode(response)).toBe("DENIED");
  });

  it("rejects a revoked token with 401", async () => {
    const response = await call("GET", `/v2/${REPO}/tags/list`, {
      headers: { Authorization: basic("robot", revokedToken) },
    });
    expect(response.status).toBe(401);
    expect(await errorCode(response)).toBe("UNAUTHORIZED");
  });
});

describe("bearer tokens", () => {
  it("rejects a malformed JWT with 401", async () => {
    // A garbage bearer must be a challenge to re-authenticate, never a quiet fall
    // back to anonymous access.
    const response = await call("GET", "/v2/", {
      headers: { Authorization: "Bearer not.a.jwt" },
    });
    expect(response.status).toBe(401);
    expect(await errorCode(response)).toBe("UNAUTHORIZED");
  });
});
