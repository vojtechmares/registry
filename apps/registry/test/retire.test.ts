/**
 * The single deletion path a retention run takes, against real D1.
 *
 * It must consult the same immutability guard the API's delete endpoints do -
 * `ProjectPolicy` - so a project with immutable tags refuses a retention
 * deletion of a tagged target exactly as it refuses the API's, and it must
 * record one lifecycle event per retirement, always attributed to the project.
 */

import { env } from "cloudflare:test";
import { beforeAll, describe, expect, it } from "vitest";
import { Retirer } from "../src/lifecycle/retire.js";
import { ProjectPolicy } from "../src/policy.js";
import { CleanupStore } from "../src/storage/cleanup.js";
import { ProjectStore } from "../src/storage/projects.js";
import { SignatureIndex } from "../src/storage/signatures.js";
import { TagIndex } from "../src/storage/tags.js";
import { seedRepository, seedUser } from "./helpers.js";

const NOW = Date.parse("2026-07-10T00:00:00Z");
const digest = (seed: string) => `sha256:${seed.repeat(64).slice(0, 64)}`;

function retirer(): Retirer {
  return new Retirer(
    env.DB,
    new ProjectPolicy(new ProjectStore(env.DB), new SignatureIndex(env.DB), new TagIndex(env.DB)),
  );
}

async function seedManifest(repository: string, d: string): Promise<void> {
  await env.DB.prepare(
    `INSERT INTO manifests (repository, digest, media_type, artifact_type, size, subject_digest, annotations, created_at)
     VALUES (?, ?, 'application/vnd.oci.image.manifest.v1+json', NULL, 10, NULL, NULL, ?)`,
  )
    .bind(repository, d, NOW)
    .run();
}

async function seedTag(repository: string, name: string, d: string): Promise<void> {
  await env.DB.prepare(
    "INSERT INTO tags (repository, name, manifest_digest, created_at, updated_at) VALUES (?, ?, ?, ?, ?)",
  )
    .bind(repository, name, d, NOW, NOW)
    .run();
}

async function tagExists(repository: string, name: string): Promise<boolean> {
  const row = await env.DB.prepare("SELECT 1 FROM tags WHERE repository = ? AND name = ?")
    .bind(repository, name)
    .first();
  return row !== null;
}

async function manifestExists(repository: string, d: string): Promise<boolean> {
  const row = await env.DB.prepare("SELECT 1 FROM manifests WHERE repository = ? AND digest = ?")
    .bind(repository, d)
    .first();
  return row !== null;
}

beforeAll(async () => {
  await seedUser({ id: "ret-root", username: "retroot", password: "correct-horse-battery", isAdmin: true });
});

describe("the retirer", () => {
  it("retires a tag and records the retirement against the project", async () => {
    await seedRepository("ret-a/app");
    await seedManifest("ret-a/app", digest("a"));
    await seedTag("ret-a/app", "old", digest("a"));

    const removed = await retirer().retireTag("ret-a", "ret-a/app", "old", "beyond the newest 1", NOW);

    expect(removed).toBe(true);
    expect(await tagExists("ret-a/app", "old")).toBe(false);
    const events = await new CleanupStore(env.DB).events("ret-a", 10);
    expect(events[0]).toMatchObject({ action: "retire-tag", subject: "old", repository: "ret-a/app" });
  });

  it("refuses to retire a tag in a project that enforces immutability, and records nothing", async () => {
    await seedRepository("ret-b/app", { name: "ret-b", immutableTags: true });
    await seedManifest("ret-b/app", digest("b"));
    await seedTag("ret-b/app", "v1", digest("b"));

    const removed = await retirer().retireTag("ret-b", "ret-b/app", "v1", "beyond the newest 1", NOW);

    expect(removed).toBe(false);
    expect(await tagExists("ret-b/app", "v1")).toBe(true);
    expect(await new CleanupStore(env.DB).events("ret-b", 10)).toHaveLength(0);
  });

  it("refuses to retire a manifest an immutable tag names", async () => {
    await seedRepository("ret-c/app", { name: "ret-c", immutableTags: true });
    await seedManifest("ret-c/app", digest("c"));
    await seedTag("ret-c/app", "v1", digest("c"));

    const removed = await retirer().retireManifest("ret-c", "ret-c/app", digest("c"), "untagged", NOW);

    expect(removed).toBe(false);
    expect(await manifestExists("ret-c/app", digest("c"))).toBe(true);
  });

  it("still retires an untagged manifest even in an immutable project, which has no tag to protect", async () => {
    await seedRepository("ret-d/app", { name: "ret-d", immutableTags: true });
    await seedManifest("ret-d/app", digest("d"));

    const removed = await retirer().retireManifest(
      "ret-d",
      "ret-d/app",
      digest("d"),
      "untagged for more than 30 days",
      NOW,
    );

    expect(removed).toBe(true);
    expect(await manifestExists("ret-d/app", digest("d"))).toBe(false);
    const events = await new CleanupStore(env.DB).events("ret-d", 10);
    expect(events[0]).toMatchObject({
      action: "retire-manifest",
      subject: digest("d"),
      repository: "ret-d/app",
    });
  });
});
