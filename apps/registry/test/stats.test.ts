/**
 * Usage counters against real D1.
 *
 * The counters are written from `waitUntil`, after the response has gone out.
 * `SELF.fetch` resolves once the response is ready, so every assertion here
 * first drains the body and then waits for the scheduled work to settle -
 * otherwise it would be racing the very thing it is testing.
 */

import { SELF, env } from "cloudflare:test";
import { beforeAll, describe, expect, it } from "vitest";
import type { UsageStats } from "@registry/api-contract";
import { dayToIso } from "@registry/projects";
import { basic, call, deterministic, digestOf, seedProject, seedRepository, seedUser } from "./helpers.js";

const ADMIN = { id: "stats-root", username: "statsroot", password: "correct-horse-battery" };
const auth = basic(ADMIN.username, ADMIN.password);

const MANIFEST_TYPE = "application/vnd.oci.image.manifest.v1+json";

/** Lets `waitUntil` work drain before the test looks at what it wrote. */
async function settle(): Promise<void> {
  await SELF.fetch("https://registry.test/healthz");
  await scheduler.wait(20);
}

async function seedBlob(repository: string, bytes: Uint8Array): Promise<string> {
  const digest = await digestOf(bytes);
  await call("POST", `/v2/${repository}/blobs/uploads/?digest=${digest}`, {
    headers: { Authorization: auth, "Content-Length": String(bytes.length) },
    body: bytes as unknown as BodyInit,
  });
  return digest;
}

async function pushImage(repository: string, reference: string, seed: number): Promise<string> {
  const config = deterministic(32, seed);
  const configDigest = await seedBlob(repository, config);
  const body = JSON.stringify({
    schemaVersion: 2,
    mediaType: MANIFEST_TYPE,
    config: { mediaType: "application/vnd.oci.image.config.v1+json", digest: configDigest, size: 32 },
    layers: [],
  });

  const response = await call("PUT", `/v2/${repository}/manifests/${reference}`, {
    headers: { Authorization: auth, "Content-Type": MANIFEST_TYPE },
    body,
  });
  expect(response.status).toBe(201);
  return digestOf(new TextEncoder().encode(body));
}

async function pull(repository: string, reference: string): Promise<number> {
  const response = await call("GET", `/v2/${repository}/manifests/${reference}`, {
    headers: { Authorization: auth },
  });
  await response.arrayBuffer();
  return response.status;
}

async function statsFor(path: string): Promise<UsageStats> {
  const response = await call("GET", path, { headers: { Authorization: auth } });
  expect(response.status).toBe(200);
  return (await response.json()) as UsageStats;
}

beforeAll(async () => {
  await seedUser({ ...ADMIN, isAdmin: true });
});

describe("recording activity", () => {
  it("counts a manifest push and each manifest pull", async () => {
    await seedRepository("stats-a/app");
    await pushImage("stats-a/app", "v1", 1);
    expect(await pull("stats-a/app", "v1")).toBe(200);
    expect(await pull("stats-a/app", "v1")).toBe(200);
    await settle();

    const stats = await statsFor("/api/v1/projects/stats-a/stats");
    expect(stats.totals).toEqual({ pulls: 2, pushes: 1, deletes: 0 });
  });

  it("does not count a layer upload as a push", async () => {
    await seedRepository("stats-b/app");
    // Three blobs, no manifest: a `docker push` reports one push, not four.
    await seedBlob("stats-b/app", deterministic(64, 10));
    await seedBlob("stats-b/app", deterministic(64, 11));
    await seedBlob("stats-b/app", deterministic(64, 12));
    await settle();

    const stats = await statsFor("/api/v1/projects/stats-b/stats");
    expect(stats.totals).toEqual({ pulls: 0, pushes: 0, deletes: 0 });
  });

  it("does not count a HEAD, which fetches no manifest body", async () => {
    await seedRepository("stats-head/app");
    await pushImage("stats-head/app", "v1", 20);
    const response = await call("HEAD", "/v2/stats-head/app/manifests/v1", {
      headers: { Authorization: auth },
    });
    expect(response.status).toBe(200);
    await settle();

    const stats = await statsFor("/api/v1/projects/stats-head/stats");
    expect(stats.totals.pulls).toBe(0);
  });

  it("counts a tag deletion", async () => {
    await seedRepository("stats-c/app");
    await pushImage("stats-c/app", "v1", 2);
    const response = await call("DELETE", "/v2/stats-c/app/manifests/v1", {
      headers: { Authorization: auth },
    });
    expect(response.status).toBe(202);
    await settle();

    const stats = await statsFor("/api/v1/projects/stats-c/stats");
    expect(stats.totals.deletes).toBe(1);
  });

  it("folds a request's events into one row per repository per day", async () => {
    await seedRepository("stats-d/app");
    await pushImage("stats-d/app", "v1", 3);
    await pull("stats-d/app", "v1");
    await settle();

    const rows = await env.DB.prepare("SELECT COUNT(*) AS n FROM stats_daily WHERE project = ?")
      .bind("stats-d")
      .first<{ n: number }>();
    expect(rows?.n).toBe(1);
  });
});

describe("reporting activity", () => {
  it("attributes a project's numbers to the images that earned them", async () => {
    await seedRepository("stats-e/hot");
    await seedRepository("stats-e/cold");

    await pushImage("stats-e/hot", "v1", 4);
    await pushImage("stats-e/cold", "v1", 5);
    await pull("stats-e/hot", "v1");
    await pull("stats-e/hot", "v1");
    await pull("stats-e/hot", "v1");
    await pull("stats-e/cold", "v1");
    await settle();

    const stats = await statsFor("/api/v1/projects/stats-e/stats");
    expect(stats.totals.pulls).toBe(4);

    // Ordered by pulls, so the busiest image leads.
    expect(stats.repositories?.map((entry) => entry.repository)).toEqual(["stats-e/hot", "stats-e/cold"]);
    expect(stats.repositories?.[0]?.pulls).toBe(3);
    expect(stats.repositories?.[1]?.pulls).toBe(1);
  });

  it("reports one image on its own", async () => {
    await seedRepository("stats-f/app");
    await pushImage("stats-f/app", "v1", 6);
    await pull("stats-f/app", "v1");
    await settle();

    const stats = await statsFor("/api/v1/repositories/stats-f/app/stats");
    expect(stats.scope).toBe("stats-f/app");
    expect(stats.totals).toEqual({ pulls: 1, pushes: 1, deletes: 0 });
    expect(stats.repositories).toBeUndefined();
  });

  it("reports storage the project is charged for, deduplicated", async () => {
    await seedRepository("stats-g/one");
    await seedRepository("stats-g/two");
    const bytes = deterministic(2048, 7);
    await seedBlob("stats-g/one", bytes);
    await seedBlob("stats-g/two", bytes);
    await settle();

    const stats = await statsFor("/api/v1/projects/stats-g/stats");
    expect(stats.storageBytes).toBe(2048);
  });

  it("returns a dense series, one point per day, ending today", async () => {
    await seedProject({ name: "stats-h" });
    const stats = await statsFor("/api/v1/projects/stats-h/stats?days=7");

    expect(stats.series).toHaveLength(7);
    expect(stats.series.at(-1)?.day).toBe(dayToIso(Math.floor(Date.now() / 86_400_000)));
    expect(stats.series.every((point) => point.pulls === 0)).toBe(true);
  });

  it("clamps an absurd window rather than scanning the whole table", async () => {
    await seedProject({ name: "stats-i" });
    const stats = await statsFor("/api/v1/projects/stats-i/stats?days=100000");
    expect(stats.days).toBe(365);
    expect(stats.series).toHaveLength(365);
  });

  it("hides a private project's usage from a caller who cannot see the project", async () => {
    await seedProject({ name: "stats-secret" });
    const response = await call("GET", "/api/v1/projects/stats-secret/stats");
    expect(response.status).toBe(404);
  });

  it("serves a public project's usage to an anonymous caller", async () => {
    await seedProject({ name: "stats-open", visibility: "public" });
    const response = await call("GET", "/api/v1/projects/stats-open/stats");
    expect(response.status).toBe(200);
  });
});
