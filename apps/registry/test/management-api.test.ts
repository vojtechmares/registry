/**
 * The management API's control plane, against real D1.
 *
 * The security-relevant property here is that a machine token - a data-plane
 * credential - cannot reach the control plane. An admin who mints a narrow CI
 * token must not thereby hand it the power to create another admin.
 */

import { env } from "cloudflare:test";
import { beforeAll, describe, expect, it } from "vitest";
import { formatAccessToken, hashTokenSecret } from "../src/auth/password.js";
import { basic, call, seedUser } from "./helpers.js";

const ADMIN = "root";
const ADMIN_PASSWORD = "root-password-1234";
const TOKEN_SECRET = "admin-owned-token-secret";
let adminToken: string;

beforeAll(async () => {
  await seedUser({ id: "root-id", username: ADMIN, password: ADMIN_PASSWORD, isAdmin: true });
  // A token owned by the administrator, scoped only to pull one repository.
  await env.DB.prepare(
    `INSERT INTO access_tokens (id, name, user_id, secret_hash, scopes, expires_at, revoked, created_at)
     VALUES (?, ?, ?, ?, ?, NULL, 0, ?)`,
  )
    .bind(
      "tok1",
      "ci",
      "root-id",
      await hashTokenSecret(TOKEN_SECRET),
      JSON.stringify([{ repository: "root/app", actions: ["pull"] }]),
      Date.now(),
    )
    .run();
  adminToken = formatAccessToken("tok1", TOKEN_SECRET);
});

const json = { "Content-Type": "application/json" };

describe("control plane rejects machine tokens", () => {
  it("will not let an admin-owned token create a user", async () => {
    // The token's owner is an admin, but the token itself is a scoped data-plane
    // credential. Were `isAdmin` the only check, this would escalate to a new
    // admin account and defeat the token's confinement entirely.
    const response = await call("POST", "/api/v1/users", {
      headers: { ...json, Authorization: basic("x", adminToken) },
      body: JSON.stringify({ username: "intruder", password: "intruder-1234", isAdmin: true }),
    });
    expect(response.status).toBe(403);
    expect(await env.DB.prepare("SELECT 1 FROM users WHERE username = 'intruder'").first()).toBeNull();
  });

  it("will not let a token list users or read stats", async () => {
    const auth = { headers: { Authorization: basic("x", adminToken) } };
    expect((await call("GET", "/api/v1/users", auth)).status).toBe(403);
    expect((await call("GET", "/api/v1/stats", auth)).status).toBe(403);
  });

  it("will not let a token create or list tokens", async () => {
    const list = await call("GET", "/api/v1/tokens", { headers: { Authorization: basic("x", adminToken) } });
    expect(list.status).toBe(403);

    const create = await call("POST", "/api/v1/tokens", {
      headers: { ...json, Authorization: basic("x", adminToken) },
      body: JSON.stringify({ name: "wider", scopes: [{ repository: "*", actions: ["pull", "push"] }] }),
    });
    expect(create.status).toBe(403);
  });

  it("will not exchange a machine token for a browser session", async () => {
    // The token is passed as the login password. Were a session minted, its
    // cookie would resolve as a full `user` principal and shed the token's
    // scopes - laundering a scoped credential into an admin session.
    const response = await call("POST", "/api/v1/auth/login", {
      headers: json,
      body: JSON.stringify({ username: "x", password: adminToken }),
    });
    expect(response.status).toBe(403);
    expect(response.headers.get("Set-Cookie")).toBeNull();
  });

  it("still admits the human administrator over Basic auth", async () => {
    const response = await call("GET", "/api/v1/stats", {
      headers: { Authorization: basic(ADMIN, ADMIN_PASSWORD) },
    });
    expect(response.status).toBe(200);
    const stats = (await response.json()) as { repositories: number };
    expect(typeof stats.repositories).toBe("number");
  });
});

describe("account management", () => {
  it("refuses a non-admin user's control-plane requests", async () => {
    await seedUser({ id: "bob-id", username: "bob", password: "bob-password-1234" });
    const response = await call("GET", "/api/v1/users", {
      headers: { Authorization: basic("bob", "bob-password-1234") },
    });
    expect(response.status).toBe(403);
  });

  it("requires a JSON content type on logout, so it cannot be triggered cross-site", async () => {
    // A cross-site form submits as text/plain or form-encoded; only same-origin
    // script can set application/json.
    const formPost = await call("POST", "/api/v1/auth/logout", {
      headers: { "Content-Type": "text/plain", Authorization: basic(ADMIN, ADMIN_PASSWORD) },
    });
    expect(formPost.status).toBe(400);

    const proper = await call("POST", "/api/v1/auth/logout", { headers: json });
    expect(proper.status).toBe(204);
  });
});
