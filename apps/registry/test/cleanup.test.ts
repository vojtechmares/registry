/**
 * Cron-scheduled cleanup against real D1.
 *
 * These rules delete images, so the tests spend most of their attention on what
 * must survive: a tag no rule governs, a repository no rule names, a signature
 * that is untagged by design, and a platform manifest inside an index.
 */

import { env } from "cloudflare:test";
import { beforeAll, describe, expect, it } from "vitest";
import type { CleanupRule } from "@registry/api-contract";
import { runDueCleanups } from "../src/lifecycle/cleanup.js";
import { collectGarbage } from "../src/lifecycle/garbage-collector.js";
import { runLifecycle } from "../src/lifecycle/policies.js";
import { CleanupStore } from "../src/storage/cleanup.js";
import { blobKey } from "../src/keys.js";
import { basic, call, deterministic, detail, seedProject, seedRepository, seedUser } from "./helpers.js";

const DAY = 86_400_000;
const NOW = Date.parse("2026-07-10T00:00:00Z");

const OWNER = { id: "clean-root", username: "cleanroot", password: "correct-horse-battery" };
const auth = basic(OWNER.username, OWNER.password);

async function seedTag(repository: string, name: string, daysOld: number): Promise<void> {
  const at = NOW - daysOld * DAY;
  await env.DB.prepare(
    `INSERT INTO tags (repository, name, manifest_digest, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?) ON CONFLICT (repository, name) DO UPDATE SET updated_at = excluded.updated_at`,
  )
    .bind(
      repository,
      name,
      `sha256:${name
        .padEnd(64, "0")
        .slice(0, 64)
        .replace(/[^a-f0-9]/g, "a")}`,
      at,
      at,
    )
    .run();
}

async function tagsOf(repository: string): Promise<string[]> {
  const rows = await env.DB.prepare("SELECT name FROM tags WHERE repository = ? ORDER BY name")
    .bind(repository)
    .all<{ name: string }>();
  return rows.results.map((row) => row.name);
}

async function policy(
  project: string,
  rules: CleanupRule[],
  untaggedOlderThanDays: number | null = null,
): Promise<void> {
  const store = new CleanupStore(env.DB);
  // Scheduled in the past, so the sweep finds it due.
  await store.put(project, { enabled: true, schedule: "0 3 * * *", rules, untaggedOlderThanDays }, NOW - DAY);
}

const rule = (overrides: Partial<CleanupRule> = {}): CleanupRule => ({
  repositories: "*",
  tags: {},
  keepLast: null,
  keepWithinDays: null,
  ...overrides,
});

beforeAll(async () => {
  await seedUser({ ...OWNER, isAdmin: true });
});

describe("running due cleanup policies", () => {
  it("keeps the newest tags and deletes the rest", async () => {
    await seedRepository("clean-a/app");
    await seedTag("clean-a/app", "v3", 1);
    await seedTag("clean-a/app", "v2", 10);
    await seedTag("clean-a/app", "v1", 20);
    await policy("clean-a", [rule({ keepLast: 2 })]);

    const reports = await runDueCleanups(env, NOW);
    expect(reports).toEqual([{ project: "clean-a", tagsRemoved: 1, untaggedRemoved: 0 }]);
    expect(await tagsOf("clean-a/app")).toEqual(["v2", "v3"]);
  });

  it("never touches a tag no rule governs", async () => {
    await seedRepository("clean-b/app");
    await seedTag("clean-b/app", "nightly-1", 90);
    await seedTag("clean-b/app", "v1.0.0", 90);
    await policy("clean-b", [rule({ tags: { semver: "*" }, keepLast: 0 })]);

    await runDueCleanups(env, NOW);
    // Only the version was governed, and nothing kept it.
    expect(await tagsOf("clean-b/app")).toEqual(["nightly-1"]);
  });

  it("never touches a repository no rule names", async () => {
    await seedRepository("clean-c/named");
    await seedRepository("clean-c/other");
    await seedTag("clean-c/named", "v1", 90);
    await seedTag("clean-c/other", "v1", 90);
    await policy("clean-c", [rule({ repositories: "clean-c/named" })]);

    await runDueCleanups(env, NOW);
    expect(await tagsOf("clean-c/named")).toEqual([]);
    expect(await tagsOf("clean-c/other")).toEqual(["v1"]);
  });

  it("deletes nothing when the policy has no rules", async () => {
    await seedRepository("clean-d/app");
    await seedTag("clean-d/app", "v1", 900);
    await policy("clean-d", []);

    await runDueCleanups(env, NOW);
    expect(await tagsOf("clean-d/app")).toEqual(["v1"]);
  });

  it("lets one rule protect what another would sweep", async () => {
    await seedRepository("clean-e/app");
    await seedTag("clean-e/app", "latest", 90);
    await seedTag("clean-e/app", "v1", 90);
    await policy("clean-e", [rule(), rule({ tags: { pattern: "latest" }, keepLast: 1 })]);

    await runDueCleanups(env, NOW);
    expect(await tagsOf("clean-e/app")).toEqual(["latest"]);
  });

  it("keeps the newest versions by precedence rather than by write order", async () => {
    await seedRepository("clean-f/app");
    // 1.10.0 is the newest version and the oldest write.
    await seedTag("clean-f/app", "1.10.0", 30);
    await seedTag("clean-f/app", "1.9.0", 10);
    await seedTag("clean-f/app", "1.2.0", 1);
    await policy("clean-f", [rule({ tags: { semver: "*" }, keepLast: 2, keepBy: "semver" })]);

    await runDueCleanups(env, NOW);
    expect(await tagsOf("clean-f/app")).toEqual(["1.10.0", "1.9.0"]);
  });

  it("keeps anything written inside the retention window", async () => {
    await seedRepository("clean-g/app");
    await seedTag("clean-g/app", "fresh", 2);
    await seedTag("clean-g/app", "stale", 40);
    await policy("clean-g", [rule({ keepWithinDays: 7 })]);

    await runDueCleanups(env, NOW);
    expect(await tagsOf("clean-g/app")).toEqual(["fresh"]);
  });

  it("records why each tag went", async () => {
    await seedRepository("clean-h/app");
    await seedTag("clean-h/app", "doomed", 90);
    await policy("clean-h", [rule()]);
    await runDueCleanups(env, NOW);

    const events = await new CleanupStore(env.DB).events("clean-h", 10);
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ action: "retire-tag", subject: "doomed" });
  });

  it("advances the schedule so a policy does not run twice in a row", async () => {
    await seedRepository("clean-i/app");
    await seedTag("clean-i/app", "v1", 90);
    await policy("clean-i", [rule()]);

    expect(await runDueCleanups(env, NOW)).toHaveLength(1);
    // Nothing is due any more; the next run is tomorrow at 03:00.
    expect(await runDueCleanups(env, NOW)).toHaveLength(0);

    const stored = await new CleanupStore(env.DB).get("clean-i");
    expect(stored?.nextRunAt).toBeGreaterThan(NOW);
  });

  it("leaves a disabled policy alone", async () => {
    await seedRepository("clean-j/app");
    await seedTag("clean-j/app", "v1", 90);
    await new CleanupStore(env.DB).put(
      "clean-j",
      { enabled: false, schedule: "0 3 * * *", rules: [rule()], untaggedOlderThanDays: null },
      NOW - DAY,
    );

    expect(await runDueCleanups(env, NOW)).toHaveLength(0);
    expect(await tagsOf("clean-j/app")).toEqual(["v1"]);
  });
});

const digest = (seed: string) => `sha256:${seed.repeat(64).slice(0, 64)}`;

describe("retiring untagged manifests", () => {
  async function seedManifest(
    repository: string,
    d: string,
    daysOld: number,
    fields: { subject?: string } = {},
  ): Promise<void> {
    const at = NOW - daysOld * DAY;
    await env.DB.prepare(
      `INSERT INTO manifests (repository, digest, media_type, artifact_type, size, subject_digest, annotations, created_at)
       VALUES (?, ?, 'application/vnd.oci.image.manifest.v1+json', NULL, 10, ?, NULL, ?)`,
    )
      .bind(repository, d, fields.subject ?? null, at)
      .run();
  }

  it("removes an old untagged manifest", async () => {
    await seedRepository("untag-a/app");
    await seedManifest("untag-a/app", digest("a"), 40);
    await policy("untag-a", [], 30);

    const [report] = await runDueCleanups(env, NOW);
    expect(report?.untaggedRemoved).toBe(1);
  });

  it("spares a manifest a tag still points at", async () => {
    await seedRepository("untag-b/app");
    const d = digest("b");
    await seedManifest("untag-b/app", d, 40);
    await env.DB.prepare(
      "INSERT INTO tags (repository, name, manifest_digest, created_at, updated_at) VALUES (?, 'v1', ?, ?, ?)",
    )
      .bind("untag-b/app", d, NOW, NOW)
      .run();
    await policy("untag-b", [], 30);

    const [report] = await runDueCleanups(env, NOW);
    expect(report?.untaggedRemoved).toBe(0);
  });

  it("spares a signature, which is untagged by design", async () => {
    await seedRepository("untag-c/app");
    const subject = digest("c");
    await seedManifest("untag-c/app", subject, 40);
    await seedManifest("untag-c/app", digest("d"), 40, { subject });

    await env.DB.prepare(
      "INSERT INTO tags (repository, name, manifest_digest, created_at, updated_at) VALUES (?, 'v1', ?, ?, ?)",
    )
      .bind("untag-c/app", subject, NOW, NOW)
      .run();
    await policy("untag-c", [], 30);

    const [report] = await runDueCleanups(env, NOW);
    expect(report?.untaggedRemoved).toBe(0);
  });

  it("spares a platform manifest inside an index", async () => {
    await seedRepository("untag-d/app");
    const index = digest("e");
    const child = digest("f");
    await seedManifest("untag-d/app", index, 40);
    await seedManifest("untag-d/app", child, 40);
    await env.DB.prepare(
      "INSERT INTO manifest_children (repository, manifest_digest, child_digest) VALUES (?, ?, ?)",
    )
      .bind("untag-d/app", index, child)
      .run();
    await env.DB.prepare(
      "INSERT INTO tags (repository, name, manifest_digest, created_at, updated_at) VALUES (?, 'v1', ?, ?, ?)",
    )
      .bind("untag-d/app", index, NOW, NOW)
      .run();
    await policy("untag-d", [], 30);

    const [report] = await runDueCleanups(env, NOW);
    expect(report?.untaggedRemoved).toBe(0);
  });
});

describe("the cleanup policy API", () => {
  it("refuses a schedule that is not a cron expression", async () => {
    await seedProject({ name: "api-clean" });
    const response = await call("PUT", "/api/v1/projects/api-clean/cleanup", {
      headers: { Authorization: auth, "Content-Type": "application/json" },
      body: JSON.stringify({ enabled: true, schedule: "every tuesday", rules: [] }),
    });
    expect(response.status).toBe(400);
  });

  it("refuses a rule whose semver range will not parse", async () => {
    await seedProject({ name: "api-clean2" });
    const response = await call("PUT", "/api/v1/projects/api-clean2/cleanup", {
      headers: { Authorization: auth, "Content-Type": "application/json" },
      body: JSON.stringify({
        enabled: true,
        schedule: "0 3 * * *",
        rules: [{ repositories: "*", tags: { semver: "garbage" }, keepLast: 1, keepWithinDays: null }],
      }),
    });
    expect(response.status).toBe(400);
    expect(await detail(response)).toContain("semver");
  });

  it("refuses a rule whose regex will not compile, naming the offset", async () => {
    await seedProject({ name: "api-clean-re" });
    const response = await call("PUT", "/api/v1/projects/api-clean-re/cleanup", {
      headers: { Authorization: auth, "Content-Type": "application/json" },
      body: JSON.stringify({
        enabled: true,
        schedule: "0 3 * * *",
        rules: [{ repositories: "*", tags: { regex: "(unclosed" }, keepLast: 1, keepWithinDays: null }],
      }),
    });
    expect(response.status).toBe(400);
    const text = await detail(response);
    expect(text).toContain("tags.regex");
    expect(text).toContain("offset");
  });

  it("refuses a rule whose regex a backtracking engine could not run safely", async () => {
    await seedProject({ name: "api-clean-bomb" });
    const response = await call("PUT", "/api/v1/projects/api-clean-bomb/cleanup", {
      headers: { Authorization: auth, "Content-Type": "application/json" },
      body: JSON.stringify({
        enabled: true,
        schedule: "0 3 * * *",
        // Lookahead cannot be simulated without backtracking, so it never reaches the cron.
        rules: [{ repositories: "*", tags: { regex: "^(?=v)" }, keepLast: 1, keepWithinDays: null }],
      }),
    });
    expect(response.status).toBe(400);
  });

  it("refuses a policy with more rules than a cron can afford to run", async () => {
    await seedProject({ name: "api-clean-many" });
    const one = { repositories: "*", tags: {}, keepLast: 1, keepWithinDays: null };
    const response = await call("PUT", "/api/v1/projects/api-clean-many/cleanup", {
      headers: { Authorization: auth, "Content-Type": "application/json" },
      body: JSON.stringify({
        enabled: true,
        schedule: "0 3 * * *",
        rules: Array.from({ length: 33 }, () => one),
      }),
    });
    expect(response.status).toBe(400);
    expect(await detail(response)).toContain("at most 32 rules");
  });

  it("accepts and stores a rule that selects by regex", async () => {
    await seedProject({ name: "api-clean-re2" });
    const nightly = {
      repositories: "*",
      tags: { regex: "^nightly-\\d{8}$" },
      keepLast: 3,
      keepWithinDays: null,
      keepBy: "updated",
    };
    const response = await call("PUT", "/api/v1/projects/api-clean-re2/cleanup", {
      headers: { Authorization: auth, "Content-Type": "application/json" },
      body: JSON.stringify({ enabled: true, schedule: "0 3 * * *", rules: [nightly] }),
    });
    expect(response.status).toBe(200);

    const stored = (await response.json()) as { rules: CleanupRule[] };
    expect(stored.rules[0]?.tags.regex).toBe("^nightly-\\d{8}$");
  });

  it("refuses a rule with an empty repository glob", async () => {
    await seedProject({ name: "api-clean3" });
    const response = await call("PUT", "/api/v1/projects/api-clean3/cleanup", {
      headers: { Authorization: auth, "Content-Type": "application/json" },
      body: JSON.stringify({
        enabled: true,
        schedule: "0 3 * * *",
        rules: [{ repositories: "", tags: {}, keepLast: 1, keepWithinDays: null }],
      }),
    });
    expect(response.status).toBe(400);
  });

  it("stores a policy and reports when it next runs", async () => {
    await seedProject({ name: "api-clean4" });
    const response = await call("PUT", "/api/v1/projects/api-clean4/cleanup", {
      headers: { Authorization: auth, "Content-Type": "application/json" },
      body: JSON.stringify({
        enabled: true,
        schedule: "0 3 * * *",
        rules: [{ repositories: "*", tags: {}, keepLast: 5, keepWithinDays: null }],
        untaggedOlderThanDays: 30,
      }),
    });
    expect(response.status).toBe(200);

    const stored = (await response.json()) as { nextRunAt: number | null; enabled: boolean };
    expect(stored.enabled).toBe(true);
    expect(stored.nextRunAt).toBeGreaterThan(Date.now());
  });

  it("gives a disabled policy no next run", async () => {
    await seedProject({ name: "api-clean5" });
    const response = await call("PUT", "/api/v1/projects/api-clean5/cleanup", {
      headers: { Authorization: auth, "Content-Type": "application/json" },
      body: JSON.stringify({ enabled: false, schedule: "0 3 * * *", rules: [] }),
    });
    const stored = (await response.json()) as { nextRunAt: number | null };
    expect(stored.nextRunAt).toBeNull();
  });

  it("is closed to a caller who does not own the project", async () => {
    await seedProject({ name: "api-clean6" });
    await seedUser({ id: "outsider", username: "outsider", password: "correct-horse-battery" });
    const response = await call("GET", "/api/v1/projects/api-clean6/cleanup", {
      headers: { Authorization: basic("outsider", "correct-horse-battery") },
    });
    expect(response.status).toBe(403);
  });
});

describe("project attribution across lifecycle-event writers", () => {
  const PROJECT = "attrib";
  const REPO = "attrib/app";

  it("surfaces retirements from every project-scoped writer in the cleanup history, but never a global blob collection", async () => {
    await seedRepository(REPO);

    // Writer 1 - the per-repository lifecycle engine. An untagged manifest past
    // the policy's TTL is retired; the resulting event must carry its project.
    const orphanManifest = `sha256:${"c".repeat(64)}`;
    await env.DB.prepare(
      `INSERT INTO manifests (repository, digest, media_type, artifact_type, size, subject_digest, annotations, created_at)
       VALUES (?, ?, 'application/vnd.oci.image.manifest.v1+json', NULL, 4, NULL, NULL, ?)`,
    )
      .bind(REPO, orphanManifest, NOW - 400 * DAY)
      .run();
    await env.DB.prepare(
      "INSERT INTO lifecycle_policies (repository, enabled, keep_last_tags, untagged_ttl_days, updated_at) VALUES (?, 1, NULL, 7, ?)",
    )
      .bind(REPO, NOW)
      .run();
    await runLifecycle(env);

    // Writer 2 - the project cleanup engine. One tag beyond the newest is retired.
    await seedTag(REPO, "keep", 1);
    await seedTag(REPO, "drop", 90);
    await policy(PROJECT, [rule({ keepLast: 1 })]);
    await runDueCleanups(env, NOW);

    // Writer 3 - the garbage collector. A blob no repository links is reclaimed;
    // it is content-addressed and registry-global, so it belongs to no project.
    const orphanBlob = `sha256:${"d".repeat(64)}`;
    const key = blobKey(orphanBlob);
    await env.DB.prepare("INSERT INTO blobs (digest, size, storage_key, created_at) VALUES (?, 8, ?, ?)")
      .bind(orphanBlob, key, NOW - DAY)
      .run();
    await env.BUCKET.put(key, deterministic(8) as unknown as ArrayBuffer);
    await collectGarbage(env);

    // The project owner reads the history the management API exposes.
    const response = await call("GET", `/api/v1/projects/${PROJECT}/events`, {
      headers: { Authorization: auth },
    });
    expect(response.status).toBe(200);
    const { events } = (await response.json()) as {
      events: Array<{ action: string; subject: string; repository: string | null }>;
    };
    const actions = events.map((event) => event.action);

    // Both project-scoped engines appear, attributed to the project.
    expect(actions).toContain("retire-manifest");
    expect(actions).toContain("retire-tag");
    // The registry-global blob collection stays out of any single project's history.
    expect(actions).not.toContain("collect-blob");
  });
});
