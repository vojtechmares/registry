/**
 * Immutable tags against real D1, driven through the registry API exactly as
 * `docker` drives it.
 *
 * The promise is narrow and total: a tag in such a project names one digest,
 * for good. So the tests care about the three ways it could be broken - moving
 * the tag, deleting the tag, and deleting the manifest under it - and about the
 * one thing that must keep working, which is pushing the same digest again.
 */

import { env } from "cloudflare:test";
import { beforeAll, describe, expect, it } from "vitest";
import { runDueCleanups } from "../src/lifecycle/cleanup.js";
import { runLifecycle } from "../src/lifecycle/policies.js";
import { D1MetadataStore } from "../src/storage/metadata.js";
import { basic, call, digestOf, errorCode, seedProject, seedRepository, seedUser } from "./helpers.js";

const ADMIN = { id: "imm-root", username: "immroot", password: "correct-horse-battery" };
const auth = basic(ADMIN.username, ADMIN.password);

const MANIFEST_TYPE = "application/vnd.oci.image.manifest.v1+json";
const CONFIG_TYPE = "application/vnd.oci.image.config.v1+json";

async function seedBlob(repository: string, bytes: Uint8Array): Promise<string> {
  const digest = await digestOf(bytes);
  const response = await call("POST", `/v2/${repository}/blobs/uploads/?digest=${digest}`, {
    headers: { Authorization: auth, "Content-Length": String(bytes.length) },
    body: bytes as unknown as BodyInit,
  });
  expect(response.status).toBe(201);
  return digest;
}

function manifestBody(configDigest: string, configSize: number): string {
  return JSON.stringify({
    schemaVersion: 2,
    mediaType: MANIFEST_TYPE,
    config: { mediaType: CONFIG_TYPE, digest: configDigest, size: configSize },
    layers: [],
  });
}

/** Pushes a distinct manifest, so that two calls give two different digests. */
async function buildManifest(repository: string, marker: string): Promise<string> {
  const config = new TextEncoder().encode(`{"marker":"${marker}"}`);
  const configDigest = await seedBlob(repository, config);
  return manifestBody(configDigest, config.length);
}

async function putManifest(repository: string, reference: string, body: string): Promise<Response> {
  return call("PUT", `/v2/${repository}/manifests/${reference}`, {
    headers: { Authorization: auth, "Content-Type": MANIFEST_TYPE },
    body,
  });
}

async function tagDigest(repository: string, tag: string): Promise<string | null> {
  const row = await env.DB.prepare("SELECT manifest_digest FROM tags WHERE repository = ? AND name = ?")
    .bind(repository, tag)
    .first<{ manifest_digest: string }>();
  return row?.manifest_digest ?? null;
}

beforeAll(async () => {
  await seedUser({ ...ADMIN, isAdmin: true });
});

describe("pushing", () => {
  it("refuses to move a tag onto a different digest", async () => {
    await seedRepository("immutable/app", { name: "immutable", immutableTags: true });

    const first = await buildManifest("immutable/app", "one");
    expect((await putManifest("immutable/app", "v1.0.0", first)).status).toBe(201);
    const pinned = await tagDigest("immutable/app", "v1.0.0");

    const second = await buildManifest("immutable/app", "two");
    const response = await putManifest("immutable/app", "v1.0.0", second);

    expect(response.status).toBe(403);
    expect(await errorCode(response)).toBe("DENIED");
    // And the tag still names what it named.
    expect(await tagDigest("immutable/app", "v1.0.0")).toBe(pinned);
  });

  it("allows re-pushing the digest the tag already names, so a CI rerun does not fail", async () => {
    await seedRepository("immutable2/app", { name: "immutable2", immutableTags: true });

    const body = await buildManifest("immutable2/app", "same");
    expect((await putManifest("immutable2/app", "v1.0.0", body)).status).toBe(201);
    expect((await putManifest("immutable2/app", "v1.0.0", body)).status).toBe(201);
  });

  it("allows a new tag, and a push by digest alone", async () => {
    await seedRepository("immutable3/app", { name: "immutable3", immutableTags: true });

    const first = await buildManifest("immutable3/app", "one");
    expect((await putManifest("immutable3/app", "v1.0.0", first)).status).toBe(201);

    // A different tag is not the tag that was promised.
    const second = await buildManifest("immutable3/app", "two");
    expect((await putManifest("immutable3/app", "v2.0.0", second)).status).toBe(201);

    // By digest, there is no tag to move.
    const third = await buildManifest("immutable3/app", "three");
    const digest = await digestOf(new TextEncoder().encode(third));
    expect((await putManifest("immutable3/app", digest, third)).status).toBe(201);
  });

  it("moves a tag freely in a project that does not enforce it", async () => {
    await seedRepository("mutable/app", { name: "mutable" });

    const first = await buildManifest("mutable/app", "one");
    expect((await putManifest("mutable/app", "v1.0.0", first)).status).toBe(201);

    const second = await buildManifest("mutable/app", "two");
    expect((await putManifest("mutable/app", "v1.0.0", second)).status).toBe(201);

    const moved = await tagDigest("mutable/app", "v1.0.0");
    expect(moved).toBe(await digestOf(new TextEncoder().encode(second)));
  });
});

describe("deleting", () => {
  it("refuses to delete an immutable tag", async () => {
    await seedRepository("immdel/app", { name: "immdel", immutableTags: true });
    const body = await buildManifest("immdel/app", "one");
    await putManifest("immdel/app", "v1.0.0", body);

    const response = await call("DELETE", "/v2/immdel/app/manifests/v1.0.0", {
      headers: { Authorization: auth },
    });

    expect(response.status).toBe(403);
    expect(await errorCode(response)).toBe("DENIED");
    expect(await tagDigest("immdel/app", "v1.0.0")).not.toBeNull();
  });

  it("refuses to delete a manifest an immutable tag names, which would take the tag with it", async () => {
    await seedRepository("immdel2/app", { name: "immdel2", immutableTags: true });
    const body = await buildManifest("immdel2/app", "one");
    await putManifest("immdel2/app", "v1.0.0", body);
    const digest = await digestOf(new TextEncoder().encode(body));

    const response = await call("DELETE", `/v2/immdel2/app/manifests/${digest}`, {
      headers: { Authorization: auth },
    });

    expect(response.status).toBe(403);
    expect(await tagDigest("immdel2/app", "v1.0.0")).toBe(digest);
  });

  it("still deletes an untagged manifest, which has no tag to protect", async () => {
    // A signature, an SBOM and a superseded image are all untagged by design.
    await seedRepository("immdel3/app", { name: "immdel3", immutableTags: true });
    const body = await buildManifest("immdel3/app", "untagged");
    const digest = await digestOf(new TextEncoder().encode(body));
    expect((await putManifest("immdel3/app", digest, body)).status).toBe(201);

    const response = await call("DELETE", `/v2/immdel3/app/manifests/${digest}`, {
      headers: { Authorization: auth },
    });
    expect(response.status).toBe(202);
  });

  it("answers 404 for a tag that does not exist, rather than 403", async () => {
    // Refusing first would turn every missing tag in the project into a refusal.
    await seedRepository("immdel4/app", { name: "immdel4", immutableTags: true });
    const response = await call("DELETE", "/v2/immdel4/app/manifests/nosuchtag", {
      headers: { Authorization: auth },
    });
    expect(response.status).toBe(404);
  });
});

describe("scheduled cleanup", () => {
  const NOW = Date.parse("2026-07-10T00:00:00Z");

  it("retires no tag in a project that enforces immutability", async () => {
    await seedRepository("immclean/app", { name: "immclean", immutableTags: true });
    for (const tag of ["v1", "v2", "v3"]) {
      await putManifest("immclean/app", tag, await buildManifest("immclean/app", tag));
    }

    // A rule that would otherwise keep only the newest and sweep the rest.
    await env.DB.prepare(
      `INSERT INTO cleanup_policies (project, enabled, schedule, rules, next_run_at, updated_at)
       VALUES (?, 1, '0 3 * * *', ?, ?, ?)`,
    )
      .bind(
        "immclean",
        JSON.stringify([{ repositories: "*", tags: {}, keepLast: 1, keepWithinDays: null }]),
        NOW - 1000,
        NOW,
      )
      .run();

    const [report] = await runDueCleanups(env, NOW);
    expect(report?.tagsRemoved).toBe(0);

    const remaining = await env.DB.prepare("SELECT COUNT(*) AS n FROM tags WHERE repository = ?")
      .bind("immclean/app")
      .first<{ n: number }>();
    expect(remaining?.n).toBe(3);
  });

  it("retires tags as usual in a project that does not", async () => {
    await seedRepository("mutclean/app", { name: "mutclean" });
    for (const tag of ["v1", "v2", "v3"]) {
      await putManifest("mutclean/app", tag, await buildManifest("mutclean/app", tag));
    }

    await env.DB.prepare(
      `INSERT INTO cleanup_policies (project, enabled, schedule, rules, next_run_at, updated_at)
       VALUES (?, 1, '0 3 * * *', ?, ?, ?)`,
    )
      .bind(
        "mutclean",
        JSON.stringify([{ repositories: "*", tags: {}, keepLast: 1, keepWithinDays: null }]),
        NOW - 1000,
        NOW,
      )
      .run();

    const reports = await runDueCleanups(env, NOW);
    const report = reports.find((entry) => entry.project === "mutclean");
    expect(report?.tagsRemoved).toBe(2);
  });

  it("trims no tag under the per-repository lifecycle policy either", async () => {
    // The other cron that retires tags, and the one it is easiest to forget.
    await seedRepository("immlife/app", { name: "immlife", immutableTags: true });
    for (const tag of ["v1", "v2", "v3"]) {
      await putManifest("immlife/app", tag, await buildManifest("immlife/app", tag));
    }

    await env.DB.prepare(
      `INSERT INTO lifecycle_policies (repository, enabled, keep_last_tags, updated_at)
       VALUES (?, 1, 1, ?)`,
    )
      .bind("immlife/app", Date.now())
      .run();

    await runLifecycle(env);

    const remaining = await env.DB.prepare("SELECT COUNT(*) AS n FROM tags WHERE repository = ?")
      .bind("immlife/app")
      .first<{ n: number }>();
    expect(remaining?.n).toBe(3);
  });
});

describe("the storage backstop", () => {
  /**
   * The policy hook reads the tag and the store then writes it. Two pushes of
   * different digests to the same *new* tag both find nothing to protect, so
   * both are permitted and one silently overwrites the other. These drive the
   * store directly, which is the only way to stand where that race stands.
   */
  it("refuses to move an immutable tag even when the policy hook is bypassed", async () => {
    await seedRepository("immrace/app", { name: "immrace", immutableTags: true });
    const store = new D1MetadataStore(env.DB);

    await store.tagManifest("immrace/app", "v1.0.0", "sha256:" + "a".repeat(64));
    await store.tagManifest("immrace/app", "v1.0.0", "sha256:" + "b".repeat(64));

    expect(await tagDigest("immrace/app", "v1.0.0")).toBe("sha256:" + "a".repeat(64));
  });

  it("still lets the same digest be re-tagged, and a mutable project move its tags", async () => {
    await seedRepository("mutrace/app", { name: "mutrace" });
    const store = new D1MetadataStore(env.DB);

    await store.tagManifest("mutrace/app", "v1.0.0", "sha256:" + "a".repeat(64));
    await store.tagManifest("mutrace/app", "v1.0.0", "sha256:" + "b".repeat(64));
    expect(await tagDigest("mutrace/app", "v1.0.0")).toBe("sha256:" + "b".repeat(64));

    await seedRepository("immrace2/app", { name: "immrace2", immutableTags: true });
    await store.tagManifest("immrace2/app", "v1.0.0", "sha256:" + "c".repeat(64));
    await store.tagManifest("immrace2/app", "v1.0.0", "sha256:" + "c".repeat(64));
    expect(await tagDigest("immrace2/app", "v1.0.0")).toBe("sha256:" + "c".repeat(64));
  });
});

describe("the project settings API", () => {
  it("turns immutability on and reports it", async () => {
    await seedProject({ name: "immapi" });

    const response = await call("PATCH", "/api/v1/projects/immapi", {
      headers: { Authorization: auth, "Content-Type": "application/json" },
      body: JSON.stringify({ immutableTags: true }),
    });
    expect(response.status).toBe(200);

    const project = (await response.json()) as { immutableTags: boolean };
    expect(project.immutableTags).toBe(true);
  });

  it("refuses a value that is not a boolean", async () => {
    await seedProject({ name: "immapi2" });
    const response = await call("PATCH", "/api/v1/projects/immapi2", {
      headers: { Authorization: auth, "Content-Type": "application/json" },
      body: JSON.stringify({ immutableTags: "yes" }),
    });
    expect(response.status).toBe(400);
  });
});
