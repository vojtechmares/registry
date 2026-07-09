/**
 * The project model against real D1: path segmentation decides which project a
 * push lands in, membership decides who may push there, the quota decides
 * whether the bytes fit, and a project-scoped token cannot leave its project.
 */

import { env } from "cloudflare:test";
import { beforeAll, describe, expect, it } from "vitest";
import { formatAccessToken, hashTokenSecret } from "../src/auth/password.js";
import type { Scope } from "../src/auth/scopes.js";
import {
  basic,
  call,
  deterministic,
  digestOf,
  errorCode,
  projectUsage,
  seedMember,
  seedProject,
  seedRepository,
  seedUser,
} from "./helpers.js";

const ADMIN = { id: "root-id", username: "root", password: "correct-horse-battery" };
const ALICE = { id: "alice-id", username: "alice", password: "correct-horse-battery" };
const BOB = { id: "bob-id", username: "bob", password: "correct-horse-battery" };

const adminAuth = basic(ADMIN.username, ADMIN.password);
const aliceAuth = basic(ALICE.username, ALICE.password);
const bobAuth = basic(BOB.username, BOB.password);

interface SeedTokenOptions {
  readonly id: string;
  readonly secret: string;
  readonly userId: string;
  readonly scopes: Scope[];
  readonly project: string | null;
}

async function seedToken(options: SeedTokenOptions): Promise<string> {
  await env.DB.prepare(
    `INSERT INTO access_tokens (id, name, user_id, secret_hash, scopes, project, expires_at, revoked, created_at)
     VALUES (?, ?, ?, ?, ?, ?, NULL, 0, ?)`,
  )
    .bind(
      options.id,
      options.id,
      options.userId,
      await hashTokenSecret(options.secret),
      JSON.stringify(options.scopes),
      options.project,
      Date.now(),
    )
    .run();
  return formatAccessToken(options.id, options.secret);
}

/**
 * Uploads a blob monolithically. `auth` of null sends no `Authorization` header
 * at all, which is a genuinely anonymous request - an empty header is merely a
 * malformed one, and would be refused before authorization is ever consulted.
 */
async function pushBlob(repository: string, bytes: Uint8Array, auth: string | null): Promise<Response> {
  const digest = await digestOf(bytes);
  const headers: Record<string, string> = { "Content-Length": String(bytes.length) };
  if (auth !== null) headers.Authorization = auth;

  return call("POST", `/v2/${repository}/blobs/uploads/?digest=${digest}`, {
    headers,
    body: bytes as unknown as BodyInit,
  });
}

beforeAll(async () => {
  await seedUser({ ...ADMIN, isAdmin: true });
  await seedUser(ALICE);
  await seedUser(BOB);
});

describe("path-based segmentation", () => {
  it("creates the project named by the first path segment on first push", async () => {
    const response = await pushBlob("acme-seg/api", deterministic(64, 1), adminAuth);
    expect(response.status).toBe(201);

    const row = await env.DB.prepare("SELECT project FROM repositories WHERE name = ?")
      .bind("acme-seg/api")
      .first<{ project: string }>();
    expect(row?.project).toBe("acme-seg");
  });

  it("files a deeply nested repository under its first segment alone", async () => {
    await pushBlob("acme-deep/team/service", deterministic(64, 2), adminAuth);
    const row = await env.DB.prepare("SELECT project FROM repositories WHERE name = ?")
      .bind("acme-deep/team/service")
      .first<{ project: string }>();
    expect(row?.project).toBe("acme-deep");
  });

  it("lets a user push into the project named after them without any grant", async () => {
    const response = await pushBlob("alice/tools", deterministic(64, 3), aliceAuth);
    expect(response.status).toBe(201);
  });

  it("refuses a user pushing into a project that does not exist and is not theirs", async () => {
    const response = await pushBlob("someone-else/tools", deterministic(64, 4), aliceAuth);
    expect(response.status).toBe(403);
    expect(await errorCode(response)).toBe("DENIED");
  });

  it("does not let a name prefix pass for the project itself", async () => {
    // `alicebob` is not `alice`, however it sorts.
    const response = await pushBlob("alicebob/tools", deterministic(64, 5), aliceAuth);
    expect(response.status).toBe(403);
  });
});

describe("project membership", () => {
  beforeAll(async () => {
    await seedRepository("members-test/app");
    await seedMember("members-test", ALICE.id, "developer");
    await seedMember("members-test", BOB.id, "guest");
  });

  it("lets a developer push", async () => {
    const response = await pushBlob("members-test/app", deterministic(64, 10), aliceAuth);
    expect(response.status).toBe(201);
  });

  it("refuses a guest's push but admits their pull", async () => {
    const push = await pushBlob("members-test/app", deterministic(64, 11), bobAuth);
    expect(push.status).toBe(403);

    const pull = await call("GET", "/v2/members-test/app/tags/list", {
      headers: { Authorization: bobAuth },
    });
    expect(pull.status).toBe(200);
  });

  it("refuses a developer's delete: that is a maintainer's job", async () => {
    const bytes = deterministic(64, 12);
    await pushBlob("members-test/app", bytes, aliceAuth);
    const response = await call("DELETE", `/v2/members-test/app/blobs/${await digestOf(bytes)}`, {
      headers: { Authorization: aliceAuth },
    });
    expect(response.status).toBe(403);
  });

  it("hides a private project from a non-member entirely", async () => {
    await seedRepository("hidden-proj/app");
    const response = await call("GET", "/v2/hidden-proj/app/tags/list", {
      headers: { Authorization: bobAuth },
    });
    expect(response.status).toBe(403);
  });

  it("serves a public project to an anonymous caller", async () => {
    await seedRepository("open-proj/app", { name: "open-proj", visibility: "public" });
    const response = await call("GET", "/v2/open-proj/app/tags/list");
    expect(response.status).toBe(200);
  });

  it("still refuses an anonymous push to a public project", async () => {
    await seedRepository("open-push/app", { name: "open-push", visibility: "public" });
    const response = await pushBlob("open-push/app", deterministic(64, 13), null);
    expect(response.status).toBe(401);
  });
});

describe("storage quotas", () => {
  it("charges the project once for a blob two of its repositories share", async () => {
    await seedRepository("quota-dedup/one");
    await seedRepository("quota-dedup/two");

    const bytes = deterministic(512, 20);
    expect((await pushBlob("quota-dedup/one", bytes, adminAuth)).status).toBe(201);
    expect(await projectUsage("quota-dedup")).toBe(512);

    expect((await pushBlob("quota-dedup/two", bytes, adminAuth)).status).toBe(201);
    expect(await projectUsage("quota-dedup")).toBe(512);
  });

  it("does not charge twice when the same repository re-pushes a blob", async () => {
    await seedRepository("quota-repush/app");
    const bytes = deterministic(256, 21);

    await pushBlob("quota-repush/app", bytes, adminAuth);
    await pushBlob("quota-repush/app", bytes, adminAuth);
    expect(await projectUsage("quota-repush")).toBe(256);
  });

  it("refuses a blob that would take the project over its quota", async () => {
    await seedRepository("quota-full/app", { name: "quota-full", quotaBytes: 1000 });

    expect((await pushBlob("quota-full/app", deterministic(600, 22), adminAuth)).status).toBe(201);

    const response = await pushBlob("quota-full/app", deterministic(600, 23), adminAuth);
    expect(response.status).toBe(403);
    expect(await errorCode(response)).toBe("DENIED");
    expect(await projectUsage("quota-full")).toBe(600);
  });

  it("admits a blob that exactly fills the quota", async () => {
    await seedRepository("quota-exact/app", { name: "quota-exact", quotaBytes: 500 });
    expect((await pushBlob("quota-exact/app", deterministic(500, 24), adminAuth)).status).toBe(201);
    expect(await projectUsage("quota-exact")).toBe(500);
  });

  it("still admits a blob the full project already stores, since it costs nothing", async () => {
    await seedRepository("quota-free/one", { name: "quota-free", quotaBytes: 300 });
    await seedRepository("quota-free/two");

    const bytes = deterministic(300, 25);
    expect((await pushBlob("quota-free/one", bytes, adminAuth)).status).toBe(201);
    // The project is exactly full, yet a mount of content it already holds adds nothing.
    expect((await pushBlob("quota-free/two", bytes, adminAuth)).status).toBe(201);
    expect(await projectUsage("quota-free")).toBe(300);
  });

  it("refunds the project when its last link to a blob goes away", async () => {
    await seedRepository("quota-refund/app");
    const bytes = deterministic(128, 26);
    await pushBlob("quota-refund/app", bytes, adminAuth);
    expect(await projectUsage("quota-refund")).toBe(128);

    const response = await call("DELETE", `/v2/quota-refund/app/blobs/${await digestOf(bytes)}`, {
      headers: { Authorization: adminAuth },
    });
    expect(response.status).toBe(202);
    expect(await projectUsage("quota-refund")).toBe(0);
  });

  it("keeps charging while another repository in the project still links the blob", async () => {
    await seedRepository("quota-hold/one");
    await seedRepository("quota-hold/two");
    const bytes = deterministic(64, 27);
    await pushBlob("quota-hold/one", bytes, adminAuth);
    await pushBlob("quota-hold/two", bytes, adminAuth);

    await call("DELETE", `/v2/quota-hold/one/blobs/${await digestOf(bytes)}`, {
      headers: { Authorization: adminAuth },
    });
    expect(await projectUsage("quota-hold")).toBe(64);
  });

  it("charges the destination project for a cross-mount, which transfers no bytes", async () => {
    await seedRepository("mount-src/app", { name: "mount-src", visibility: "public" });
    await seedProject({ name: "mount-dst" });

    const bytes = deterministic(1024, 28);
    const digest = await digestOf(bytes);
    await pushBlob("mount-src/app", bytes, adminAuth);

    const mount = await call("POST", `/v2/mount-dst/app/blobs/uploads/?mount=${digest}&from=mount-src/app`, {
      headers: { Authorization: adminAuth },
    });
    expect(mount.status).toBe(201);
    expect(await projectUsage("mount-dst")).toBe(1024);
    expect(await projectUsage("mount-src")).toBe(1024);
  });

  it("refuses a cross-mount into a project with no room for it", async () => {
    await seedRepository("mount-src2/app", { name: "mount-src2", visibility: "public" });
    await seedProject({ name: "mount-tiny", quotaBytes: 10 });

    const bytes = deterministic(1024, 29);
    const digest = await digestOf(bytes);
    await pushBlob("mount-src2/app", bytes, adminAuth);

    const mount = await call(
      "POST",
      `/v2/mount-tiny/app/blobs/uploads/?mount=${digest}&from=mount-src2/app`,
      { headers: { Authorization: adminAuth } },
    );
    expect(mount.status).toBe(403);
    expect(await projectUsage("mount-tiny")).toBe(0);
  });
});

describe("project-scoped tokens", () => {
  beforeAll(async () => {
    await seedRepository("scoped-a/app", { name: "scoped-a", visibility: "public" });
    await seedRepository("scoped-b/app", { name: "scoped-b", visibility: "public" });
  });

  it("reaches everything inside its project", async () => {
    const secret = await seedToken({
      id: "projtoken0000001",
      secret: "s".repeat(43),
      userId: ADMIN.id,
      scopes: [{ repository: "*", actions: ["pull", "push"] }],
      project: "scoped-a",
    });

    const response = await pushBlob("scoped-a/app", deterministic(64, 30), basic("root", secret));
    expect(response.status).toBe(201);
  });

  it("cannot reach another project, even with a wildcard scope and an admin owner", async () => {
    const secret = await seedToken({
      id: "projtoken0000002",
      secret: "t".repeat(43),
      userId: ADMIN.id,
      scopes: [{ repository: "*", actions: ["pull", "push"] }],
      project: "scoped-a",
    });

    const response = await pushBlob("scoped-b/app", deterministic(64, 31), basic("root", secret));
    expect(response.status).toBe(403);
    expect(await errorCode(response)).toBe("DENIED");
  });

  it("cannot reach a project whose name merely starts the same", async () => {
    await seedRepository("scoped-a-evil/app", { name: "scoped-a-evil", visibility: "public" });
    const secret = await seedToken({
      id: "projtoken0000003",
      secret: "u".repeat(43),
      userId: ADMIN.id,
      scopes: [{ repository: "*", actions: ["pull", "push"] }],
      project: "scoped-a",
    });

    const response = await pushBlob("scoped-a-evil/app", deterministic(64, 32), basic("root", secret));
    expect(response.status).toBe(403);
  });

  it("cannot trade itself at /v2/token for a bearer token that escapes the project", async () => {
    const secret = await seedToken({
      id: "projtoken0000004",
      secret: "v".repeat(43),
      userId: ADMIN.id,
      scopes: [{ repository: "*", actions: ["pull", "push"] }],
      project: "scoped-a",
    });

    const exchange = await call("GET", "/v2/token?scope=repository:scoped-b/app:push&service=registry.test", {
      headers: { Authorization: basic("root", secret) },
    });
    expect(exchange.status).toBe(200);
    const { token } = (await exchange.json()) as { token: string };

    // Even if the bearer token were minted with the scope, the project pin rides
    // along inside it and the push must still be refused.
    const push = await pushBlob("scoped-b/app", deterministic(64, 33), `Bearer ${token}`);
    expect(push.status).toBe(403);
  });
});
