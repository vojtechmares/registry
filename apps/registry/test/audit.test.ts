/**
 * Who did what, to what, and when.
 *
 * The log is only worth having if it records the things somebody would come
 * looking for: who deleted the image, who widened the quota, who minted the
 * credential, who removed the member. And if it does not record the things it
 * promised not to - a row per `docker pull` would bury all of the above.
 */

import { SELF, env } from "cloudflare:test";
import { beforeAll, describe, expect, it } from "vitest";
import type { AuditEvent, AuditPage } from "@registry/api-contract";
import { AuditStore } from "../src/audit/store.js";
import { basic, call, digestOf, seedMember, seedProject, seedRepository, seedUser } from "./helpers.js";

const ADMIN = { id: "au-root", username: "auroot", password: "correct-horse-battery" };
const ALICE = { id: "au-alice", username: "aualice", password: "alice-password-1234" };

const adminAuth = basic(ADMIN.username, ADMIN.password);
const aliceAuth = basic(ALICE.username, ALICE.password);
const json = { "Content-Type": "application/json" };

const MANIFEST_TYPE = "application/vnd.oci.image.manifest.v1+json";
const CONFIG_TYPE = "application/vnd.oci.image.config.v1+json";

beforeAll(async () => {
  await seedUser({ ...ADMIN, isAdmin: true });
  await seedUser(ALICE);
  await seedRepository("auacme/api", { name: "auacme" });
  await seedMember("auacme", ALICE.id, "owner");
});

/**
 * Lets `waitUntil` work drain before the test looks at what it wrote.
 *
 * The artifact rows are written after the response has gone out, exactly as the
 * usage counters are, so an assertion that did not wait would race them.
 */
async function settle(): Promise<void> {
  await SELF.fetch("https://registry.test/healthz");
  await scheduler.wait(20);
}

/** The audit rows for a resource, newest first, read straight from the table. */
async function rows(filter: Partial<{ action: string; project: string }> = {}): Promise<AuditEvent[]> {
  const page = await new AuditStore(env.DB).list({ limit: 100, ...filter });
  return [...page.events];
}

async function pushImage(repository: string, tag: string, marker: string): Promise<string> {
  const config = new TextEncoder().encode(`{"marker":"${marker}"}`);
  const configDigest = await digestOf(config);
  await call("POST", `/v2/${repository}/blobs/uploads/?digest=${configDigest}`, {
    headers: { Authorization: adminAuth, "Content-Length": String(config.length) },
    body: config as unknown as BodyInit,
  });

  const body = JSON.stringify({
    schemaVersion: 2,
    mediaType: MANIFEST_TYPE,
    config: { mediaType: CONFIG_TYPE, digest: configDigest, size: config.length },
    layers: [],
  });
  const response = await call("PUT", `/v2/${repository}/manifests/${tag}`, {
    headers: { Authorization: adminAuth, "Content-Type": MANIFEST_TYPE },
    body,
  });
  expect(response.status).toBe(201);
  return digestOf(new TextEncoder().encode(body));
}

describe("artifacts", () => {
  it("records a push, naming the actor and the tag", async () => {
    await pushImage("auacme/api", "v1.0.0", "one");
    await settle();

    const [event] = await rows({ action: "artifact.push" });
    expect(event?.resource).toBe("auacme/api:v1.0.0");
    expect(event?.resourceType).toBe("artifact");
    expect(event?.project).toBe("auacme");
    expect(event?.actorName).toBe(ADMIN.username);
    expect(event?.actorKind).toBe("user");
    expect(event?.detail?.digest).toMatch(/^sha256:/);
  });

  it("records a delete", async () => {
    await pushImage("auacme/api", "doomed", "two");
    const response = await call("DELETE", "/v2/auacme/api/manifests/doomed", {
      headers: { Authorization: adminAuth },
    });
    expect(response.status).toBe(202);
    await settle();

    const [event] = await rows({ action: "artifact.delete" });
    expect(event?.resource).toBe("auacme/api:doomed");
    expect(event?.detail?.tagOnly).toBe(true);
  });

  it("records no row for a pull, which the counters already know about", async () => {
    await pushImage("auacme/api", "pulled", "three");
    const response = await call("GET", "/v2/auacme/api/manifests/pulled", {
      headers: { Authorization: adminAuth },
    });
    expect(response.status).toBe(200);
    // The body streams from R2, and an undrained stream fails the storage pop.
    await response.arrayBuffer();
    await settle();

    expect(await rows({ action: "artifact.pull" })).toEqual([]);
  });

  it("names the credential when a machine token did it", async () => {
    const created = await call("POST", "/api/v1/projects/auacme/tokens", {
      headers: { ...json, Authorization: aliceAuth },
      body: JSON.stringify({ name: "ci", scopes: [{ repository: "*", actions: ["pull", "push"] }] }),
    });
    const { id, secret } = (await created.json()) as { id: string; secret: string };

    const config = new TextEncoder().encode('{"marker":"token"}');
    const configDigest = await digestOf(config);
    await call("POST", `/v2/auacme/api/blobs/uploads/?digest=${configDigest}`, {
      headers: { Authorization: basic("x", secret), "Content-Length": String(config.length) },
      body: config as unknown as BodyInit,
    });
    await call("PUT", "/v2/auacme/api/manifests/by-token", {
      headers: { Authorization: basic("x", secret), "Content-Type": MANIFEST_TYPE },
      body: JSON.stringify({
        schemaVersion: 2,
        mediaType: MANIFEST_TYPE,
        config: { mediaType: CONFIG_TYPE, digest: configDigest, size: config.length },
        layers: [],
      }),
    });
    await settle();

    const [event] = await rows({ action: "artifact.push" });
    expect(event?.actorKind).toBe("token");
    // The owner and the credential are different answers to different questions.
    expect(event?.actorName).toBe(ALICE.username);
    expect(event?.actorTokenId).toBe(id);
  });

  it("names the same credential when the push goes through the bearer flow", async () => {
    // What `docker push` actually does: exchange the token for a bearer at
    // /v2/token, then push with that. The bearer's own `jti` is fresh every five
    // minutes and names nothing that can be revoked, so it must not be recorded.
    const created = await call("POST", "/api/v1/projects/auacme/tokens", {
      headers: { ...json, Authorization: aliceAuth },
      body: JSON.stringify({ name: "ci-bearer", scopes: [{ repository: "*", actions: ["pull", "push"] }] }),
    });
    const { id, secret } = (await created.json()) as { id: string; secret: string };

    const exchanged = await call("GET", "/v2/token?scope=repository:auacme/api:push,pull&service=registry", {
      headers: { Authorization: basic("x", secret) },
    });
    expect(exchanged.status).toBe(200);
    const { token } = (await exchanged.json()) as { token: string };
    const bearer = { Authorization: `Bearer ${token}` };

    const config = new TextEncoder().encode('{"marker":"bearer"}');
    const configDigest = await digestOf(config);
    await call("POST", `/v2/auacme/api/blobs/uploads/?digest=${configDigest}`, {
      headers: { ...bearer, "Content-Length": String(config.length) },
      body: config as unknown as BodyInit,
    });
    const pushed = await call("PUT", "/v2/auacme/api/manifests/via-bearer", {
      headers: { ...bearer, "Content-Type": MANIFEST_TYPE },
      body: JSON.stringify({
        schemaVersion: 2,
        mediaType: MANIFEST_TYPE,
        config: { mediaType: CONFIG_TYPE, digest: configDigest, size: config.length },
        layers: [],
      }),
    });
    expect(pushed.status).toBe(201);
    await settle();

    const [event] = await rows({ action: "artifact.push" });
    expect(event?.actorKind).toBe("token");
    expect(event?.actorTokenId).toBe(id);
  });
});

describe("the control plane", () => {
  it("records a project's settings changing, and what they changed to", async () => {
    await seedProject({ name: "auquota" });
    await seedMember("auquota", ALICE.id, "owner");

    await call("PATCH", "/api/v1/projects/auquota", {
      headers: { ...json, Authorization: aliceAuth },
      body: JSON.stringify({ quotaBytes: 50 * 1024 ** 3, immutableTags: true }),
    });

    const [event] = await rows({ action: "project.update" });
    expect(event?.resource).toBe("auquota");
    expect(event?.actorName).toBe(ALICE.username);
    expect(event?.detail?.quotaBytes).toBe(50 * 1024 ** 3);
    expect(event?.detail?.immutableTags).toBe(true);
  });

  it("records a member being added and removed", async () => {
    await seedProject({ name: "aumembers" });
    await seedMember("aumembers", ALICE.id, "owner");
    await seedUser({ id: "au-bob", username: "aubob", password: "bob-password-12345" });

    await call("POST", "/api/v1/projects/aumembers/members", {
      headers: { ...json, Authorization: aliceAuth },
      body: JSON.stringify({ username: "aubob", role: "developer" }),
    });
    await call("DELETE", "/api/v1/projects/aumembers/members/au-bob", {
      headers: { Authorization: aliceAuth },
    });

    const added = await rows({ action: "member.add" });
    expect(added[0]?.detail).toMatchObject({ username: "aubob", role: "developer" });
    const removed = await rows({ action: "member.remove" });
    expect(removed[0]?.detail).toMatchObject({ userId: "au-bob" });
  });

  it("records a token being minted and revoked", async () => {
    const created = await call("POST", "/api/v1/projects/auacme/tokens", {
      headers: { ...json, Authorization: aliceAuth },
      body: JSON.stringify({ name: "short-lived", scopes: [{ repository: "*", actions: ["pull"] }] }),
    });
    const { id } = (await created.json()) as { id: string };

    const minted = await rows({ action: "token.create" });
    expect(minted[0]?.resource).toBe(id);
    expect(minted[0]?.resourceType).toBe("token");
    expect(minted[0]?.project).toBe("auacme");

    await call("DELETE", `/api/v1/projects/auacme/tokens/${id}`, { headers: { Authorization: aliceAuth } });
    const revoked = await rows({ action: "token.revoke" });
    expect(revoked[0]?.resource).toBe(id);
  });

  it("records a user being created and deleted, and outlives the account", async () => {
    const created = await call("POST", "/api/v1/users", {
      headers: { ...json, Authorization: adminAuth },
      body: JSON.stringify({ username: "audoomed", password: "a-long-password", email: "d@example.com" }),
    });
    const { id } = (await created.json()) as { id: string };

    await call("DELETE", `/api/v1/users/${id}`, { headers: { Authorization: adminAuth } });

    // The user is gone; both rows about them remain, naming them.
    expect(await env.DB.prepare("SELECT 1 FROM users WHERE id = ?").bind(id).first()).toBeNull();
    const deleted = await rows({ action: "user.delete" });
    expect(deleted[0]?.resource).toBe(id);
    expect(deleted[0]?.detail).toMatchObject({ username: "audoomed" });
    expect((await rows({ action: "user.create" }))[0]?.resource).toBe(id);
  });

  it("records a repository being deleted", async () => {
    await seedRepository("audel/app", { name: "audel" });
    await call("DELETE", "/api/v1/repositories/audel/app", { headers: { Authorization: adminAuth } });

    const [event] = await rows({ action: "repository.delete" });
    expect(event?.resource).toBe("audel/app");
    expect(event?.resourceType).toBe("repository");
    expect(event?.project).toBe("audel");
  });

  it("records nothing for a change that was refused", async () => {
    // An audit log records what happened, and a refusal did not happen.
    await seedProject({ name: "aurefused" });
    const response = await call("PATCH", "/api/v1/projects/aurefused", {
      headers: { ...json, Authorization: aliceAuth },
      body: JSON.stringify({ quotaBytes: 1 }),
    });
    expect(response.status).toBe(403);
    expect(await rows({ project: "aurefused" })).toEqual([]);
  });
});

describe("the read API", () => {
  it("is closed to everyone but an administrator", async () => {
    expect((await call("GET", "/api/v1/audit", { headers: { Authorization: aliceAuth } })).status).toBe(403);
    expect((await call("GET", "/api/v1/audit")).status).toBe(401);
  });

  it("filters by resource type, actor and action", async () => {
    await pushImage("auacme/api", "filtered", "filter");
    await settle();
    const auth = { headers: { Authorization: adminAuth } };
    const read = async (query: string): Promise<AuditPage> => {
      const response = await call("GET", `/api/v1/audit?${query}`, auth);
      expect(response.status).toBe(200);
      return (await response.json()) as AuditPage;
    };

    const byType = await read("resourceType=artifact");
    expect(byType.events.length).toBeGreaterThan(0);
    expect(byType.events.every((event) => event.resourceType === "artifact")).toBe(true);

    const byActor = await read(`actor=${ADMIN.username}`);
    expect(byActor.events.length).toBeGreaterThan(0);
    expect(byActor.events.every((event) => event.actorName === ADMIN.username)).toBe(true);

    const byAction = await read("action=artifact.push");
    expect(byAction.events.every((event) => event.action === "artifact.push")).toBe(true);

    const noMatch = await read("actor=nobody");
    expect(noMatch.events).toEqual([]);
    expect(noMatch.cursor).toBeNull();
  });

  it("refuses a resource type it does not audit", async () => {
    const response = await call("GET", "/api/v1/audit?resourceType=blob", {
      headers: { Authorization: adminAuth },
    });
    expect(response.status).toBe(400);
  });

  it("pages with a cursor, never skipping a row written in between", async () => {
    const store = new AuditStore(env.DB);
    const actor = { id: "au-root", name: "auroot", kind: "user" as const, tokenId: null };
    // The same millisecond for all of them, which is what defeats an offset.
    for (let i = 0; i < 5; i++) {
      await store.record(
        { actor, action: "test.page", resourceType: "project", resource: `p${i}`, project: `p${i}` },
        1_000_000,
      );
    }

    const first = await store.list({ action: "test.page", limit: 2 });
    expect(first.events).toHaveLength(2);
    expect(first.cursor).not.toBeNull();

    const second = await store.list({ action: "test.page", limit: 2, cursor: first.cursor! });
    const third = await store.list({ action: "test.page", limit: 2, cursor: second.cursor! });

    const seen = [...first.events, ...second.events, ...third.events].map((event) => event.resource);
    expect(new Set(seen).size).toBe(5);
    expect(third.cursor).toBeNull();
  });
});

describe("retention", () => {
  it("prunes rows older than the window and keeps the rest", async () => {
    const store = new AuditStore(env.DB);
    const actor = { id: null, name: "system", kind: "system" as const, tokenId: null };
    const now = Date.parse("2026-07-10T00:00:00Z");
    const entry = { actor, action: "test.old", resourceType: "project" as const, resource: "p" };

    await store.record(entry, now - 400 * 86_400_000);
    await store.record(entry, now - 10 * 86_400_000);

    expect(await store.prune(365 * 86_400_000, now)).toBe(1);
    expect((await store.list({ action: "test.old", limit: 10 })).events).toHaveLength(1);
  });
});
