/**
 * Nightly maintenance against real D1 and R2: garbage collection reclaims
 * content nothing links any more, and the lifecycle policy retires untagged
 * manifests while sparing the ones other manifests still depend on.
 */

import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { collectGarbage } from "../src/lifecycle/garbage-collector.js";
import { runLifecycle } from "../src/lifecycle/policies.js";
import { blobKey } from "../src/keys.js";
import type { Env } from "../src/env.js";
import { deterministic } from "./helpers.js";

const HOUR_MS = 60 * 60 * 1000;
const DAY_MS = 24 * HOUR_MS;

/** A syntactically valid digest built from a single hex nibble, unique per letter. */
function digest(nibble: string): string {
  return `sha256:${nibble.repeat(64)}`;
}

async function insertBlob(dgst: string, createdAt: number): Promise<string> {
  const key = blobKey(dgst);
  await env.DB.prepare("INSERT INTO blobs (digest, size, storage_key, created_at) VALUES (?, ?, ?, ?)")
    .bind(dgst, 8, key, createdAt)
    .run();
  await env.BUCKET.put(key, deterministic(8) as unknown as ArrayBuffer);
  return key;
}

async function blobExists(dgst: string): Promise<boolean> {
  const row = await env.DB.prepare("SELECT 1 FROM blobs WHERE digest = ?").bind(dgst).first();
  return row !== null;
}

describe("garbage collection of unreferenced blobs", () => {
  it("reclaims an old unlinked blob but respects the grace period for a fresh one", async () => {
    const now = Date.now();

    // Unlinked and well past the grace period: a push that never finished linking
    // it, long enough ago to be certain it was abandoned.
    const stale = digest("a");
    const staleKey = await insertBlob(stale, now - 2 * HOUR_MS);

    // Unlinked but only just written: this is indistinguishable from a push still
    // in flight, so it must be left alone.
    const fresh = digest("b");
    const freshKey = await insertBlob(fresh, now);

    const report = await collectGarbage(env);
    expect(report.blobs).toBe(1);

    // The stale blob is gone from both the metadata store and the bucket, in that
    // order, so no object is ever left without a row naming it.
    expect(await blobExists(stale)).toBe(false);
    expect(await env.BUCKET.head(staleKey)).toBeNull();

    // The fresh blob survives untouched.
    expect(await blobExists(fresh)).toBe(true);
    expect(await env.BUCKET.head(freshKey)).not.toBeNull();
  });
});

describe("lifecycle retirement of untagged manifests", () => {
  const REPO = "lc/app";
  const OCI_MANIFEST = "application/vnd.oci.image.manifest.v1+json";
  const OCI_INDEX = "application/vnd.oci.image.index.v1+json";

  async function insertManifest(options: {
    digest: string;
    mediaType?: string;
    subjectDigest?: string;
    createdAt: number;
  }): Promise<void> {
    await env.DB.prepare(
      `INSERT INTO manifests (repository, digest, media_type, artifact_type, size, subject_digest, annotations, created_at)
       VALUES (?, ?, ?, NULL, 4, ?, NULL, ?)`,
    )
      .bind(
        REPO,
        options.digest,
        options.mediaType ?? OCI_MANIFEST,
        options.subjectDigest ?? null,
        options.createdAt,
      )
      .run();
  }

  async function tag(name: string, dgst: string): Promise<void> {
    const now = Date.now();
    await env.DB.prepare(
      "INSERT INTO tags (repository, name, manifest_digest, created_at, updated_at) VALUES (?, ?, ?, ?, ?)",
    )
      .bind(REPO, name, dgst, now, now)
      .run();
  }

  async function manifestExists(dgst: string): Promise<boolean> {
    const row = await env.DB.prepare("SELECT 1 FROM manifests WHERE repository = ? AND digest = ?")
      .bind(REPO, dgst)
      .first();
    return row !== null;
  }

  it("spares referrers and index children, deletes plain untagged manifests past the TTL", async () => {
    const now = Date.now();
    const old = now - 30 * DAY_MS;

    // The registry-wide TTL only bites once configured above zero.
    const lifecycleEnv: Env = { ...env, UNTAGGED_MANIFEST_TTL_DAYS: "7" };

    await env.DB.prepare(
      "INSERT INTO repositories (name, visibility, created_at, updated_at) VALUES (?, 'private', ?, ?)",
    )
      .bind(REPO, now, now)
      .run();

    const image = digest("1");
    const index = digest("2");
    const child = digest("3");
    const signature = digest("4");
    const plain = digest("5");
    const danglingSignature = digest("6");
    const recent = digest("7");

    // A tagged image and its signature: the signature is untagged by design and
    // its subject still exists, so it must survive its own age.
    await insertManifest({ digest: image, createdAt: old });
    await tag("stable", image);
    await insertManifest({ digest: signature, subjectDigest: image, createdAt: old });

    // A tagged multi-arch index and one of its platform manifests, which is
    // untagged but reachable through the index and must not be pulled out from
    // under it.
    await insertManifest({ digest: index, mediaType: OCI_INDEX, createdAt: old });
    await tag("multi", index);
    await insertManifest({ digest: child, createdAt: old });
    await env.DB.prepare(
      "INSERT INTO manifest_children (repository, manifest_digest, child_digest) VALUES (?, ?, ?)",
    )
      .bind(REPO, index, child)
      .run();

    // A plain untagged manifest with nothing pointing at it: this is the garbage
    // the policy exists to remove.
    await insertManifest({ digest: plain, createdAt: old });

    // A signature whose subject no longer exists is a dangling artifact, so the
    // protection does not apply and it is retired like any other orphan.
    await insertManifest({ digest: danglingSignature, subjectDigest: digest("f"), createdAt: old });

    // An untagged manifest younger than the TTL: too recent to retire yet.
    await insertManifest({ digest: recent, createdAt: now });

    const report = await runLifecycle(lifecycleEnv);
    expect(report.untaggedManifestsRemoved).toBe(2);

    // Protected: tagged content, its attached signature, and the index child.
    expect(await manifestExists(image)).toBe(true);
    expect(await manifestExists(index)).toBe(true);
    expect(await manifestExists(signature)).toBe(true);
    expect(await manifestExists(child)).toBe(true);

    // Retired: the plain orphan and the dangling signature.
    expect(await manifestExists(plain)).toBe(false);
    expect(await manifestExists(danglingSignature)).toBe(false);

    // Spared by the TTL: still within its grace window.
    expect(await manifestExists(recent)).toBe(true);
  });
});
