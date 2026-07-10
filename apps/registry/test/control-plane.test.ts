/**
 * The control plane is closed to machine tokens, on every route.
 *
 * A machine token is a data-plane credential: it exists to pull and push within
 * a declared set of scopes. The guard that enforces this now lives in one place
 * - the middleware chain - so this file walks every control-plane route with the
 * most powerful token that can exist: owned by an administrator, pinned to the
 * project it is attacking, and scoped to everything inside it.
 *
 * If a route is added without its guard, it appears here as a `2xx`.
 */

import { env } from "cloudflare:test";
import { beforeAll, describe, expect, it } from "vitest";
import { formatAccessToken, hashTokenSecret } from "../src/auth/password.js";
import { basic, call, seedMember, seedProject, seedRepository, seedUser } from "./helpers.js";

const ADMIN = { id: "cp-root", username: "cproot", password: "correct-horse-battery" };
const PROJECT = "cpacme";

let tokenAuth: string;

beforeAll(async () => {
  await seedUser({ ...ADMIN, isAdmin: true });
  await seedProject({ name: PROJECT });
  await seedRepository(`${PROJECT}/api`, { name: PROJECT });
  await seedMember(PROJECT, ADMIN.id, "owner");

  const secret = "c".repeat(43);
  await env.DB.prepare(
    `INSERT INTO access_tokens (id, name, user_id, secret_hash, scopes, project, expires_at, revoked, created_at)
     VALUES (?, ?, ?, ?, ?, ?, NULL, 0, ?)`,
  )
    .bind(
      "cptoken000000001",
      "ci",
      ADMIN.id,
      await hashTokenSecret(secret),
      JSON.stringify([{ repository: "*", actions: ["pull", "push", "delete"] }]),
      PROJECT,
      Date.now(),
    )
    .run();

  tokenAuth = basic("x", formatAccessToken("cptoken000000001", secret));
});

interface Attempt {
  readonly method: string;
  readonly path: string;
  /** A body good enough to pass validation, so a `400` cannot be mistaken for a refusal. */
  readonly body?: unknown;
}

const ROUTES: readonly Attempt[] = [
  { method: "GET", path: "/api/v1/stats" },
  { method: "GET", path: "/api/v1/audit" },
  { method: "GET", path: "/api/v1/users" },
  {
    method: "POST",
    path: "/api/v1/users",
    body: { username: "cpintruder", password: "a-long-password", email: "i@example.com" },
  },
  { method: "PATCH", path: `/api/v1/users/${ADMIN.id}`, body: { email: "stolen@example.com" } },
  { method: "DELETE", path: `/api/v1/users/${ADMIN.id}` },
  { method: "GET", path: "/api/v1/tokens" },
  {
    method: "POST",
    path: "/api/v1/tokens",
    body: { name: "wider", project: PROJECT, scopes: [{ repository: "*", actions: ["pull"] }] },
  },
  { method: "DELETE", path: "/api/v1/tokens/whatever" },
  { method: "POST", path: "/api/v1/projects", body: { name: "cproot" } },
  { method: "PATCH", path: `/api/v1/projects/${PROJECT}`, body: { immutableTags: false } },
  { method: "DELETE", path: `/api/v1/projects/${PROJECT}` },
  { method: "GET", path: `/api/v1/projects/${PROJECT}/members` },
  {
    method: "POST",
    path: `/api/v1/projects/${PROJECT}/members`,
    body: { username: ADMIN.username, role: "owner" },
  },
  { method: "PUT", path: `/api/v1/projects/${PROJECT}/members/${ADMIN.id}`, body: { role: "guest" } },
  { method: "DELETE", path: `/api/v1/projects/${PROJECT}/members/${ADMIN.id}` },
  { method: "GET", path: `/api/v1/projects/${PROJECT}/cleanup` },
  {
    method: "PUT",
    path: `/api/v1/projects/${PROJECT}/cleanup`,
    body: { enabled: true, schedule: "0 3 * * *", rules: [] },
  },
  { method: "GET", path: `/api/v1/projects/${PROJECT}/events` },
  { method: "GET", path: `/api/v1/projects/${PROJECT}/tokens` },
  {
    method: "POST",
    path: `/api/v1/projects/${PROJECT}/tokens`,
    body: { name: "x", scopes: [{ repository: "*", actions: ["pull"] }] },
  },
  { method: "DELETE", path: `/api/v1/projects/${PROJECT}/tokens/whatever` },
  { method: "GET", path: `/api/v1/projects/${PROJECT}/notifications` },
  {
    method: "POST",
    path: `/api/v1/projects/${PROJECT}/notifications`,
    body: {
      name: "hook",
      targetType: "webhook",
      target: "https://example.com/h",
      eventTypes: ["PUSH_ARTIFACT"],
    },
  },
  { method: "DELETE", path: `/api/v1/projects/${PROJECT}/notifications/whatever` },
  { method: "GET", path: `/api/v1/projects/${PROJECT}/deliveries` },
  { method: "GET", path: `/api/v1/projects/${PROJECT}/replication` },
  {
    method: "POST",
    path: `/api/v1/projects/${PROJECT}/replication`,
    body: { name: "r", direction: "push", remoteUrl: "https://r.test" },
  },
  { method: "POST", path: `/api/v1/projects/${PROJECT}/replication/whatever`, body: {} },
  { method: "DELETE", path: `/api/v1/projects/${PROJECT}/replication/whatever` },
  { method: "GET", path: `/api/v1/projects/${PROJECT}/executions` },
];

describe("a machine token cannot reach the control plane", () => {
  it.each(ROUTES)("$method $path", async ({ method, path, body }) => {
    const headers: Record<string, string> = { Authorization: tokenAuth };
    if (body !== undefined) headers["Content-Type"] = "application/json";

    const response = await call(method, path, {
      headers,
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });

    // 403, never a 400 that reveals the schema and never a 2xx that performs it.
    expect(response.status).toBe(403);
    expect((await response.json()) as { error: string }).toMatchObject({ error: "forbidden" });
  });

  it("changed nothing while trying", async () => {
    expect(await env.DB.prepare("SELECT 1 FROM users WHERE username = 'cpintruder'").first()).toBeNull();
    expect(
      await env.DB.prepare("SELECT 1 FROM projects WHERE name = ?").bind(PROJECT).first(),
    ).not.toBeNull();
    expect(await env.DB.prepare("SELECT 1 FROM users WHERE id = ?").bind(ADMIN.id).first()).not.toBeNull();
  });

  it("still lets the same token do the data-plane work it was minted for", async () => {
    const response = await call("GET", `/v2/${PROJECT}/api/tags/list`, {
      headers: { Authorization: tokenAuth },
    });
    expect(response.status).toBe(200);
  });
});
