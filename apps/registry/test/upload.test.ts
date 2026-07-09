/**
 * Resumable blob uploads, driven through the real Worker so the whole stack is
 * on the hook: the Durable Object that owns the session, the SHA-256 mid-state
 * it persists between requests, and the R2 carry object plus multipart upload
 * that assemble the bytes. The in-memory conformance suite already proves the
 * state machine's logic; this proves the adapters wired underneath it agree.
 */

import { beforeAll, describe, expect, it } from "vitest";
import { basic, call, deterministic, digestOf, errorCode, seedUser } from "./helpers.js";

const REPO = "acme/app";
const USER = "uploader";
const PASSWORD = "uploader-password-1234";
const AUTH = { Authorization: basic(USER, PASSWORD) };

// A window one part wide is 5 MiB, so 4 MiB chunks never align to a part
// boundary. Sending three of them forces the carry object to hold a different
// sub-part remainder across every request, which is the state the Durable
// Object has to persist and reload correctly.
const MIB = 1024 * 1024;
const CHUNK = 4 * MIB;
const TOTAL = 12 * MIB;

beforeAll(async () => {
  // An administrator can push to any repository, which keeps these tests about
  // the upload machinery rather than about grants.
  await seedUser({ id: "uploader-id", username: USER, password: PASSWORD, isAdmin: true });
});

async function openSession(repo = REPO): Promise<string> {
  const start = await call("POST", `/v2/${repo}/blobs/uploads/`, { headers: AUTH });
  expect(start.status).toBe(202);
  expect(start.headers.get("Range")).toBe("0-0");
  const location = start.headers.get("Location");
  expect(location).toMatch(new RegExp(`^/v2/${repo}/blobs/uploads/`));
  return location!;
}

describe("chunked upload across separate requests", () => {
  it("assembles a 12 MiB blob spanning multiple R2 parts, byte for byte", async () => {
    const started = performance.now();

    const content = deterministic(TOTAL, 42);
    const digest = await digestOf(content);
    const location = await openSession();

    let offset = 0;
    for (let index = 0; index < TOTAL / CHUNK; index++) {
      const chunk = content.subarray(offset, offset + CHUNK);
      const response = await call("PATCH", location, {
        headers: {
          ...AUTH,
          "Content-Type": "application/octet-stream",
          "Content-Length": String(chunk.length),
          "Content-Range": `${offset}-${offset + chunk.length - 1}`,
        },
        body: chunk as BodyInit,
      });
      offset += chunk.length;

      // Each accepted chunk advances the resumable offset, and the server
      // reports it as an inclusive byte range ending one before the new offset.
      expect(response.status, `chunk ${index}`).toBe(202);
      expect(response.headers.get("Range"), `chunk ${index}`).toBe(`0-${offset - 1}`);

      // A status probe mid-upload must report the same resume point, proving the
      // offset survived in Durable Object storage rather than only in the reply.
      const status = await call("GET", location, { headers: AUTH });
      expect(status.status).toBe(204);
      expect(status.headers.get("Range")).toBe(`0-${offset - 1}`);
    }
    expect(offset).toBe(TOTAL);

    // A body-less close: every byte already arrived over the PATCHes, and the
    // digest is verified against the reassembled SHA-256 mid-state.
    const put = await call("PUT", `${location}?digest=${digest}`, {
      headers: { ...AUTH, "Content-Length": "0" },
    });
    expect(put.status).toBe(201);
    expect(put.headers.get("Location")).toBe(`/v2/${REPO}/blobs/${digest}`);
    expect(put.headers.get("Docker-Content-Digest")).toBe(digest);

    const get = await call("GET", `/v2/${REPO}/blobs/${digest}`, { headers: AUTH });
    expect(get.status).toBe(200);
    expect(get.headers.get("Content-Length")).toBe(String(TOTAL));
    const returned = new Uint8Array(await get.arrayBuffer());
    expect(returned.length).toBe(TOTAL);
    // Matching digests over 12 MiB is what proves multipart reassembly kept the
    // bytes in order and lost none.
    expect(await digestOf(returned)).toBe(digest);

    console.log(`12 MiB chunked upload round trip: ${(performance.now() - started).toFixed(0)} ms`);
  });
});

describe("chunk ordering", () => {
  it("rejects a chunk that does not begin at the current offset with 416", async () => {
    const content = deterministic(64, 7);
    const location = await openSession();

    // The session is empty, so a chunk claiming to start at byte 10 cannot be
    // placed and the server refuses it rather than leaving a hole.
    const response = await call("PATCH", location, {
      headers: { ...AUTH, "Content-Length": "10", "Content-Range": "10-19" },
      body: content.subarray(10, 20) as BodyInit,
    });
    expect(response.status).toBe(416);
    expect(response.headers.get("Range")).toBe("0-0");
  });

  it("rejects replaying an already-accepted chunk with 416", async () => {
    const content = deterministic(64, 8);
    const first = content.subarray(0, 32);
    const location = await openSession();

    const accepted = await call("PATCH", location, {
      headers: { ...AUTH, "Content-Length": "32", "Content-Range": "0-31" },
      body: first as BodyInit,
    });
    expect(accepted.status).toBe(202);
    expect(accepted.headers.get("Range")).toBe("0-31");

    // Re-sending the same 0-31 chunk now starts before the offset, so it is out
    // of order and the server must not double-count it.
    const replay = await call("PATCH", location, {
      headers: { ...AUTH, "Content-Length": "32", "Content-Range": "0-31" },
      body: first as BodyInit,
    });
    expect(replay.status).toBe(416);
    expect(replay.headers.get("Range")).toBe("0-31");
  });
});

describe("digest verification on close", () => {
  it("400s a digest mismatch and destroys the session so it cannot be reused", async () => {
    const content = deterministic(128, 9);
    const wrongDigest = await digestOf(deterministic(128, 10));
    const rightDigest = await digestOf(content);
    const location = await openSession();

    await call("PATCH", location, {
      headers: {
        ...AUTH,
        "Content-Length": String(content.length),
        "Content-Range": `0-${content.length - 1}`,
      },
      body: content as BodyInit,
    });

    const mismatch = await call("PUT", `${location}?digest=${wrongDigest}`, {
      headers: { ...AUTH, "Content-Length": "0" },
    });
    expect(mismatch.status).toBe(400);
    expect(await errorCode(mismatch)).toBe("DIGEST_INVALID");

    // A mismatch is terminal: the session's multipart upload and carry are gone,
    // so even the correct digest cannot resurrect it.
    const retry = await call("PUT", `${location}?digest=${rightDigest}`, {
      headers: { ...AUTH, "Content-Length": "0" },
    });
    expect(retry.status).toBe(404);
    expect(await errorCode(retry)).toBe("BLOB_UPLOAD_UNKNOWN");
  });
});
