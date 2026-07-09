/**
 * Content addressing across the real D1 metadata store and R2 bucket: identical
 * bytes pushed by different routes must collapse to a single stored object, and
 * unlinking one repository must not disturb another that shares the content.
 */

import { env } from "cloudflare:test";
import { beforeAll, describe, expect, it } from "vitest";
import { basic, call, deterministic, digestOf, errorCode, seedUser } from "./helpers.js";

const USER = "dedup-admin";
const PASSWORD = "dedup-admin-password-1234";
const AUTH = { Authorization: basic(USER, PASSWORD) };
const MIB = 1024 * 1024;

beforeAll(async () => {
  await seedUser({ id: "dedup-admin-id", username: USER, password: PASSWORD, isAdmin: true });
});

async function blobRowCount(digest: string): Promise<number> {
  const row = await env.DB.prepare("SELECT COUNT(*) AS n FROM blobs WHERE digest = ?")
    .bind(digest)
    .first<{ n: number }>();
  return row?.n ?? -1;
}

async function chunkedPush(repo: string, content: Uint8Array, digest: string): Promise<void> {
  const start = await call("POST", `/v2/${repo}/blobs/uploads/`, { headers: AUTH });
  const location = start.headers.get("Location")!;
  const patch = await call("PATCH", location, {
    headers: {
      ...AUTH,
      "Content-Type": "application/octet-stream",
      "Content-Length": String(content.length),
    },
    body: content as BodyInit,
  });
  expect(patch.status).toBe(202);
  const put = await call("PUT", `${location}?digest=${digest}`, {
    headers: { ...AUTH, "Content-Length": "0" },
  });
  expect(put.status).toBe(201);
}

describe("deduplication", () => {
  it("stores one object for identical content pushed monolithically and in chunks", async () => {
    // Larger than a single R2 part, so the chunked push genuinely lands at a
    // staging key and then has to lose the deduplication race and clean up
    // after itself. A sub-part blob would never touch the staging path at all.
    const content = deterministic(6 * MIB, 21);
    const digest = await digestOf(content);

    // The monolithic push wins the race and registers the content-addressed
    // object first.
    const post = await call("POST", `/v2/dedup/mono/blobs/uploads/?digest=${digest}`, {
      headers: {
        ...AUTH,
        "Content-Type": "application/octet-stream",
        "Content-Length": String(content.length),
      },
      body: content as BodyInit,
    });
    expect(post.status).toBe(201);

    await chunkedPush("dedup/chunked", content, digest);

    // One digest, one row: the second upload deduplicated against the first
    // rather than inserting a rival.
    expect(await blobRowCount(digest)).toBe(1);

    // Both repositories serve the identical bytes even though only one physical
    // object exists; reading each back to its digest proves the shared object is
    // whole and reachable from either name.
    const fromMono = await call("GET", `/v2/dedup/mono/blobs/${digest}`, { headers: AUTH });
    expect(fromMono.status).toBe(200);
    expect(await digestOf(new Uint8Array(await fromMono.arrayBuffer()))).toBe(digest);

    const fromChunked = await call("GET", `/v2/dedup/chunked/blobs/${digest}`, { headers: AUTH });
    expect(fromChunked.status).toBe(200);
    expect(await digestOf(new Uint8Array(await fromChunked.arrayBuffer()))).toBe(digest);

    // The losing chunked upload deleted the staged object it wrote, so nothing
    // is orphaned under the staging prefix.
    const staged = await env.BUCKET.list({ prefix: "blobs/staged/" });
    expect(staged.objects).toHaveLength(0);
  });
});

describe("repository-scoped blob delete", () => {
  it("unlinks a blob from one repository while another keeps serving it", async () => {
    const content = deterministic(4096, 22);
    const digest = await digestOf(content);

    const post = await call("POST", `/v2/scoped/first/blobs/uploads/?digest=${digest}`, {
      headers: {
        ...AUTH,
        "Content-Type": "application/octet-stream",
        "Content-Length": String(content.length),
      },
      body: content as BodyInit,
    });
    expect(post.status).toBe(201);

    // A cross-repository mount shares the same physical object between the two
    // repositories, which is exactly the case a scoped delete must respect.
    const mount = await call("POST", `/v2/scoped/second/blobs/uploads/?mount=${digest}&from=scoped/first`, {
      headers: AUTH,
    });
    expect(mount.status).toBe(201);

    const deleted = await call("DELETE", `/v2/scoped/first/blobs/${digest}`, { headers: AUTH });
    expect(deleted.status).toBe(202);

    const gone = await call("GET", `/v2/scoped/first/blobs/${digest}`, { headers: AUTH });
    expect(gone.status).toBe(404);
    expect(await errorCode(gone)).toBe("BLOB_UNKNOWN");

    // The bytes survive wherever they are still linked, and come back intact.
    const survivor = await call("GET", `/v2/scoped/second/blobs/${digest}`, { headers: AUTH });
    expect(survivor.status).toBe(200);
    expect(await digestOf(new Uint8Array(await survivor.arrayBuffer()))).toBe(digest);

    // The delete only removed the link, not the underlying object.
    expect(await blobRowCount(digest)).toBe(1);
  });
});
