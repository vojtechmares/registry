/**
 * Access tokens belong to a project, and reach nothing outside it.
 *
 * The rule this file defends is that there is no such thing as a registry-wide
 * machine credential. A token names one project at creation, is refused at
 * authentication if it names none, and cannot be talked into naming another by
 * its scopes, by the `/v2/token` exchange, or by an administrator who owns it.
 */

import { env } from "cloudflare:test";
import { beforeAll, describe, expect, it } from "vitest";
import type { CreatedAccessToken, ProjectAccessToken } from "@registry/api-contract";
import { formatAccessToken, hashTokenSecret } from "../src/auth/password.js";
import { basic, call, seedMember, seedProject, seedRepository, seedUser } from "./helpers.js";

const ADMIN = { id: "pt-root", username: "ptroot", password: "correct-horse-battery" };
const ALICE = { id: "pt-alice", username: "ptalice", password: "alice-password-1234" };
const BOB = { id: "pt-bob", username: "ptbob", password: "bob-password-12345" };

const adminAuth = basic(ADMIN.username, ADMIN.password);
const aliceAuth = basic(ALICE.username, ALICE.password);
const bobAuth = basic(BOB.username, BOB.password);
const json = { "Content-Type": "application/json" };

beforeAll(async () => {
  await seedUser({ ...ADMIN, isAdmin: true });
  await seedUser(ALICE);
  await seedUser(BOB);
  await seedRepository("ptacme/api", { name: "ptacme" });
  await seedRepository("ptother/vault", { name: "ptother" });
  await seedMember("ptacme", ALICE.id, "owner");
  await seedMember("ptacme", BOB.id, "developer");

  // `isolatedStorage` rolls a test's writes back the instant it ends, so a
  // fixture two tests share has to be seeded before either of them runs.
  await seedProject({ name: "ptlist" });
  await seedRepository("ptlist/app", { name: "ptlist" });
  await seedMember("ptlist", ALICE.id, "owner");
  await seedMember("ptlist", BOB.id, "developer");
});

async function mint(project: string, body: unknown, auth: string): Promise<Response> {
  return call("POST", `/api/v1/projects/${project}/tokens`, {
    headers: { ...json, Authorization: auth },
    body: JSON.stringify(body),
  });
}

describe("creating", () => {
  it("mints a token pinned to the project in the path", async () => {
    const response = await mint(
      "ptacme",
      { name: "ci", scopes: [{ repository: "ptacme/api", actions: ["pull", "push"] }] },
      aliceAuth,
    );
    expect(response.status).toBe(201);

    const token = (await response.json()) as CreatedAccessToken;
    expect(token.project).toBe("ptacme");
    expect(token.secret).toBeTruthy();
  });

  it("refuses a scope that lies outside the project", async () => {
    const response = await mint(
      "ptacme",
      { name: "sneaky", scopes: [{ repository: "ptother/vault", actions: ["pull"] }] },
      aliceAuth,
    );
    expect(response.status).toBe(400);
  });

  it("refuses a body that names a different project than the path", async () => {
    const response = await mint(
      "ptacme",
      { name: "confused", project: "ptother", scopes: [{ repository: "ptacme/api", actions: ["pull"] }] },
      aliceAuth,
    );
    expect(response.status).toBe(400);
  });

  it("lets a developer mint a token no wider than the developer", async () => {
    const allowed = await mint(
      "ptacme",
      { name: "bob-ci", scopes: [{ repository: "ptacme/api", actions: ["pull", "push"] }] },
      bobAuth,
    );
    expect(allowed.status).toBe(201);

    // A developer may not delete, so a token of theirs may not either.
    const refused = await mint(
      "ptacme",
      { name: "bob-destroyer", scopes: [{ repository: "ptacme/api", actions: ["delete"] }] },
      bobAuth,
    );
    expect(refused.status).toBe(403);
  });

  it("refuses a non-member entirely", async () => {
    const response = await mint(
      "ptother",
      { name: "trespass", scopes: [{ repository: "ptother/vault", actions: ["pull"] }] },
      bobAuth,
    );
    expect(response.status).toBe(403);
  });
});

describe("POST /tokens, the flat endpoint", () => {
  it("refuses to mint a token that names no project", async () => {
    const response = await call("POST", "/api/v1/tokens", {
      headers: { ...json, Authorization: adminAuth },
      body: JSON.stringify({ name: "global", scopes: [{ repository: "*", actions: ["pull", "push"] }] }),
    });
    expect(response.status).toBe(400);
    const body = (await response.json()) as { message: string };
    expect(body.message).toContain("project is required");
  });

  it("refuses it even for an administrator, who used to be allowed", async () => {
    const response = await call("POST", "/api/v1/tokens", {
      headers: { ...json, Authorization: adminAuth },
      body: JSON.stringify({ name: "root-global", scopes: [{ repository: "*", actions: ["delete"] }] }),
    });
    expect(response.status).toBe(400);
  });

  it("mints one when the body names the project", async () => {
    const response = await call("POST", "/api/v1/tokens", {
      headers: { ...json, Authorization: aliceAuth },
      body: JSON.stringify({
        name: "flat",
        project: "ptacme",
        scopes: [{ repository: "*", actions: ["pull"] }],
      }),
    });
    expect(response.status).toBe(201);
    expect(((await response.json()) as CreatedAccessToken).project).toBe("ptacme");
  });
});

describe("authenticating", () => {
  /** Inserts a token row directly, so a `project` of null can be spelled at all. */
  async function seedRaw(id: string, secret: string, project: string | null): Promise<string> {
    await env.DB.prepare(
      `INSERT INTO access_tokens (id, name, user_id, secret_hash, scopes, project, expires_at, revoked, created_at)
       VALUES (?, ?, ?, ?, ?, ?, NULL, 0, ?)`,
    )
      .bind(
        id,
        id,
        ADMIN.id,
        await hashTokenSecret(secret),
        JSON.stringify([{ repository: "*", actions: ["pull", "push", "delete"] }]),
        project,
        Date.now(),
      )
      .run();
    return formatAccessToken(id, secret);
  }

  it("refuses a token with no project, on the data plane", async () => {
    const secret = await seedRaw("ptunpinned000001", "u".repeat(43), null);
    const response = await call("GET", "/v2/ptacme/api/tags/list", {
      headers: { Authorization: basic("x", secret) },
    });
    expect(response.status).toBe(401);
  });

  it("refuses to exchange a token with no project for a bearer at /v2/token", async () => {
    const secret = await seedRaw("ptunpinned000002", "v".repeat(43), null);
    const response = await call("GET", "/v2/token?scope=repository:ptacme/api:pull&service=registry", {
      headers: { Authorization: basic("x", secret) },
    });
    expect(response.status).toBe(401);
  });

  it("accepts a pinned token, and confines it to its project", async () => {
    const secret = await seedRaw("ptpinned00000001", "w".repeat(43), "ptacme");

    const inside = await call("GET", "/v2/ptacme/api/tags/list", {
      headers: { Authorization: basic("x", secret) },
    });
    expect(inside.status).toBe(200);

    // The scope says `*` and the owner is an administrator. The pin still wins.
    const outside = await call("GET", "/v2/ptother/vault/tags/list", {
      headers: { Authorization: basic("x", secret) },
    });
    expect(outside.status).toBe(403);
  });
});

describe("listing and revoking", () => {
  it("shows an owner every token in the project, and whose it is", async () => {
    await mint("ptlist", { name: "alice-ci", scopes: [{ repository: "*", actions: ["pull"] }] }, aliceAuth);
    await mint("ptlist", { name: "bob-ci", scopes: [{ repository: "*", actions: ["pull"] }] }, bobAuth);

    const response = await call("GET", "/api/v1/projects/ptlist/tokens", {
      headers: { Authorization: aliceAuth },
    });
    expect(response.status).toBe(200);

    const { tokens } = (await response.json()) as { tokens: ProjectAccessToken[] };
    expect(tokens.map((token) => [token.name, token.username]).toSorted()).toEqual([
      ["alice-ci", ALICE.username],
      ["bob-ci", BOB.username],
    ]);
    // The secret is minted once and never listed.
    expect(tokens.every((token) => !("secret" in token))).toBe(true);
  });

  it("does not show a mere member the project's tokens", async () => {
    const response = await call("GET", "/api/v1/projects/ptlist/tokens", {
      headers: { Authorization: bobAuth },
    });
    expect(response.status).toBe(403);
  });

  it("lets an owner revoke a token a member minted", async () => {
    const created = await mint(
      "ptlist",
      { name: "doomed", scopes: [{ repository: "*", actions: ["pull"] }] },
      bobAuth,
    );
    const { id } = (await created.json()) as CreatedAccessToken;

    const revoke = await call("DELETE", `/api/v1/projects/ptlist/tokens/${id}`, {
      headers: { Authorization: aliceAuth },
    });
    expect(revoke.status).toBe(204);

    expect(await env.DB.prepare("SELECT 1 FROM access_tokens WHERE id = ?").bind(id).first()).toBeNull();
  });

  it("will not revoke a token that belongs to another project", async () => {
    const created = await mint(
      "ptacme",
      { name: "elsewhere", scopes: [{ repository: "*", actions: ["pull"] }] },
      aliceAuth,
    );
    const { id } = (await created.json()) as CreatedAccessToken;

    // Alice owns `ptlist` too, so the guard that must bite is the project
    // predicate on the delete, not the ownership check on the route.
    const revoke = await call("DELETE", `/api/v1/projects/ptlist/tokens/${id}`, {
      headers: { Authorization: aliceAuth },
    });
    expect(revoke.status).toBe(404);

    expect(await env.DB.prepare("SELECT 1 FROM access_tokens WHERE id = ?").bind(id).first()).not.toBeNull();
  });
});
