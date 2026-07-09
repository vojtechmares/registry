/**
 * The distribution-spec behaviours the official Go conformance suite asserts,
 * run against in-memory ports.
 *
 * The Go suite is the authority and it runs against the deployed Worker, but it
 * is slow and opaque when something breaks. Encoding the same expectations here
 * gives a fast, precise signal on the logic itself.
 */

import { beforeEach, describe, expect, it } from "vitest";
import { MEDIA_TYPE_OCI_INDEX, MEDIA_TYPE_OCI_MANIFEST, sha256Hex } from "@registry/oci";
import { handleRegistryRequest } from "../src/registry.js";
import { PART_SIZE } from "../src/upload-session.js";
import { createTestRegistry, digestOfBytes, type TestRegistry } from "./memory.js";

const NAME = "myorg/myrepo";
const CROSSMOUNT = "myorg/other";
const BASE = "https://registry.example.com";

const DUMMY_DIGEST = digestOfBytes(new TextEncoder().encode("hello world"));

let registry: TestRegistry;

function bytes(...values: number[]): Uint8Array {
  return new Uint8Array(values);
}

function deterministic(size: number, seed = 1): Uint8Array {
  const out = new Uint8Array(size);
  for (let i = 0; i < size; i++) out[i] = (i * 31 + seed * 7) & 0xff;
  return out;
}

async function call(method: string, path: string, init: RequestInit = {}): Promise<Response> {
  const response = await handleRegistryRequest(new Request(`${BASE}${path}`, { method, ...init }), registry);
  if (response === null) throw new Error(`no route matched ${method} ${path}`);
  return response;
}

/** Uploads a blob the simple way, so tests that need content can get on with it. */
async function seedBlob(name: string, content: Uint8Array): Promise<string> {
  const digest = digestOfBytes(content);
  const response = await call("POST", `/v2/${name}/blobs/uploads/?digest=${digest}`, {
    body: content as BodyInit,
    headers: { "Content-Length": String(content.length) },
  });
  expect(response.status).toBe(201);
  return digest;
}

function manifestFor(
  configDigest: string,
  configSize: number,
  layers: Array<{ digest: string; size: number }> = [],
) {
  return {
    schemaVersion: 2,
    mediaType: MEDIA_TYPE_OCI_MANIFEST,
    config: { mediaType: "application/vnd.oci.image.config.v1+json", digest: configDigest, size: configSize },
    layers: layers.map((layer) => ({
      mediaType: "application/vnd.oci.image.layer.v1.tar+gzip",
      digest: layer.digest,
      size: layer.size,
    })),
  };
}

async function putManifest(
  name: string,
  reference: string,
  document: unknown,
  contentType = MEDIA_TYPE_OCI_MANIFEST,
) {
  const body = new TextEncoder().encode(JSON.stringify(document));
  const response = await call("PUT", `/v2/${name}/manifests/${reference}`, {
    body: body as BodyInit,
    headers: { "Content-Type": contentType },
  });
  return { response, digest: digestOfBytes(body), size: body.length };
}

beforeEach(() => {
  registry = createTestRegistry();
});

describe("base endpoint (end-1)", () => {
  it("answers 200 with an empty JSON object", async () => {
    const response = await call("GET", "/v2/");
    expect(response.status).toBe(200);
    expect(response.headers.get("Docker-Distribution-API-Version")).toBe("registry/2.0");
    expect(await response.json()).toEqual({});
  });
});

describe("pull (end-2, end-3)", () => {
  it("returns 404 for a nonexistent blob on GET and HEAD", async () => {
    expect((await call("HEAD", `/v2/${NAME}/blobs/${DUMMY_DIGEST}`)).status).toBe(404);
    expect((await call("GET", `/v2/${NAME}/blobs/${DUMMY_DIGEST}`)).status).toBe(404);
  });

  it("serves an existing blob with its digest and length", async () => {
    const content = bytes(1, 2, 3, 4, 5);
    const digest = await seedBlob(NAME, content);

    const head = await call("HEAD", `/v2/${NAME}/blobs/${digest}`);
    expect(head.status).toBe(200);
    expect(head.headers.get("Docker-Content-Digest")).toBe(digest);
    expect(head.headers.get("Content-Length")).toBe("5");

    const get = await call("GET", `/v2/${NAME}/blobs/${digest}`);
    expect(get.status).toBe(200);
    expect(new Uint8Array(await get.arrayBuffer())).toEqual(content);
  });

  it("honours Range requests on blobs", async () => {
    const content = deterministic(100);
    const digest = await seedBlob(NAME, content);

    const partial = await call("GET", `/v2/${NAME}/blobs/${digest}`, { headers: { Range: "bytes=10-19" } });
    expect(partial.status).toBe(206);
    expect(partial.headers.get("Content-Range")).toBe("bytes 10-19/100");
    expect(new Uint8Array(await partial.arrayBuffer())).toEqual(content.subarray(10, 20));

    const suffix = await call("GET", `/v2/${NAME}/blobs/${digest}`, { headers: { Range: "bytes=-5" } });
    expect(suffix.status).toBe(206);
    expect(new Uint8Array(await suffix.arrayBuffer())).toEqual(content.subarray(95));

    const openEnded = await call("GET", `/v2/${NAME}/blobs/${digest}`, { headers: { Range: "bytes=90-" } });
    expect(openEnded.status).toBe(206);
    expect(openEnded.headers.get("Content-Range")).toBe("bytes 90-99/100");

    // A last-byte-pos past the end is clamped, not refused.
    const clamped = await call("GET", `/v2/${NAME}/blobs/${digest}`, { headers: { Range: "bytes=95-999" } });
    expect(clamped.status).toBe(206);
    expect(clamped.headers.get("Content-Range")).toBe("bytes 95-99/100");
  });

  it("refuses a range that cannot be satisfied, and ignores one that is malformed", async () => {
    const content = deterministic(100);
    const digest = await seedBlob(NAME, content);
    const url = `/v2/${NAME}/blobs/${digest}`;

    // Beyond the object, and a zero-length suffix: both unsatisfiable.
    expect((await call("GET", url, { headers: { Range: "bytes=200-300" } })).status).toBe(416);
    expect((await call("GET", url, { headers: { Range: "bytes=-0" } })).status).toBe(416);

    // RFC 9110 requires an invalid Range to be ignored rather than refused, so
    // the client gets the whole object instead of a confusing 416.
    for (const range of ["bytes=5-3", "bytes=abc", "chunks=1-2", "bytes=1-2, 5-6"]) {
      const response = await call("GET", url, { headers: { Range: range } });
      expect(response.status, range).toBe(200);
      expect(new Uint8Array(await response.arrayBuffer()), range).toEqual(content);
    }
  });

  it("resolves manifests by tag and by digest", async () => {
    const config = bytes(9, 9, 9);
    const configDigest = await seedBlob(NAME, config);
    const { response, digest } = await putManifest(
      NAME,
      "tagtest0",
      manifestFor(configDigest, config.length),
    );
    expect(response.status).toBe(201);
    expect(response.headers.get("Docker-Content-Digest")).toBe(digest);
    expect(response.headers.get("Location")).toBe(`/v2/${NAME}/manifests/${digest}`);

    for (const reference of ["tagtest0", digest]) {
      const head = await call("HEAD", `/v2/${NAME}/manifests/${reference}`);
      expect(head.status, reference).toBe(200);
      expect(head.headers.get("Docker-Content-Digest")).toBe(digest);
      expect(head.headers.get("Content-Type")).toBe(MEDIA_TYPE_OCI_MANIFEST);

      const get = await call("GET", `/v2/${NAME}/manifests/${reference}`);
      expect(get.status, reference).toBe(200);
    }
  });

  it("stores the manifest byte-for-byte", async () => {
    const config = bytes(1);
    const configDigest = await seedBlob(NAME, config);
    // Unusual spacing and an unknown field: the response must reproduce both.
    const raw = `{"schemaVersion":2,  "mediaType":"${MEDIA_TYPE_OCI_MANIFEST}","newUnspecifiedField":null,"config":{"mediaType":"application/vnd.oci.image.config.v1+json","digest":"${configDigest}","size":1},"layers":[]}`;
    const body = new TextEncoder().encode(raw);
    const digest = digestOfBytes(body);

    const put = await call("PUT", `/v2/${NAME}/manifests/${digest}`, {
      body: body as BodyInit,
      headers: { "Content-Type": MEDIA_TYPE_OCI_MANIFEST },
    });
    expect(put.status).toBe(201);

    const get = await call("GET", `/v2/${NAME}/manifests/${digest}`);
    expect(await get.text()).toBe(raw);
  });

  it("404s an invalid tag but 400s an invalid digest", async () => {
    // `.INVALID_MANIFEST_NAME` can only be a tag, and an unusable tag names nothing.
    expect((await call("GET", `/v2/${NAME}/manifests/.INVALID_MANIFEST_NAME`)).status).toBe(404);
    expect((await call("HEAD", `/v2/${NAME}/manifests/.INVALID_MANIFEST_NAME`)).status).toBe(404);

    // `sha256:totallywrong` contains a colon, so it can only be a malformed digest.
    const response = await call("GET", `/v2/${NAME}/manifests/sha256:totallywrong`);
    expect(response.status).toBe(400);
    const body = (await response.json()) as { errors: Array<{ code: string }> };
    expect(body.errors[0]!.code).toBe("DIGEST_INVALID");
  });
});

describe("push: monolithic (end-4b, end-6)", () => {
  it("accepts a single POST carrying the digest and the blob", async () => {
    const content = deterministic(64);
    const digest = digestOfBytes(content);
    const response = await call("POST", `/v2/${NAME}/blobs/uploads/?digest=${digest}`, {
      body: content as BodyInit,
      headers: { "Content-Length": "64" },
    });
    expect(response.status).toBe(201);
    expect(response.headers.get("Location")).toBe(`/v2/${NAME}/blobs/${digest}`);
    expect((await call("GET", `/v2/${NAME}/blobs/${digest}`)).status).toBe(200);
  });

  it("rejects a single POST whose content does not match the digest", async () => {
    const response = await call("POST", `/v2/${NAME}/blobs/uploads/?digest=${DUMMY_DIGEST}`, {
      body: bytes(1, 2, 3) as BodyInit,
      headers: { "Content-Length": "3" },
    });
    expect(response.status).toBe(400);
    expect(((await response.json()) as { errors: Array<{ code: string }> }).errors[0]!.code).toBe(
      "DIGEST_INVALID",
    );
  });

  it("accepts POST then PUT with the whole body", async () => {
    const start = await call("POST", `/v2/${NAME}/blobs/uploads/`);
    expect(start.status).toBe(202);
    const location = start.headers.get("Location")!;
    expect(location).toMatch(new RegExp(`^/v2/${NAME}/blobs/uploads/`));
    expect(start.headers.get("Range")).toBe("0-0");

    const content = deterministic(1000, 3);
    const digest = digestOfBytes(content);
    const put = await call("PUT", `${location}?digest=${digest}`, {
      body: content as BodyInit,
      headers: { "Content-Length": "1000" },
    });
    expect(put.status).toBe(201);
    expect(put.headers.get("Location")).toBe(`/v2/${NAME}/blobs/${digest}`);
  });
});

describe("push: streamed (end-5, end-6)", () => {
  it("accepts a PATCH with no Content-Range, then a body-less PUT", async () => {
    const start = await call("POST", `/v2/${NAME}/blobs/uploads/`);
    const location = start.headers.get("Location")!;

    const content = deterministic(42, 2);
    const digest = digestOfBytes(content);

    const patch = await call("PATCH", location, {
      body: content as BodyInit,
      headers: { "Content-Type": "application/octet-stream" },
    });
    expect(patch.status).toBe(202);

    // The suite sends a Content-Length header on this body-less PUT. It must not
    // be read as a promise of 42 more bytes.
    const put = await call("PUT", `${patch.headers.get("Location")}?digest=${digest}`, {
      headers: { "Content-Length": "42" },
    });
    expect(put.status).toBe(201);

    const get = await call("GET", `/v2/${NAME}/blobs/${digest}`);
    expect(new Uint8Array(await get.arrayBuffer())).toEqual(content);
  });
});

describe("push: chunked (end-5, end-13)", () => {
  const content = deterministic(42, 4);
  const digest = digestOfBytes(content);
  const chunk1 = content.subarray(0, 22);
  const chunk2 = content.subarray(22);

  it("rejects an out-of-order first chunk with 416", async () => {
    const start = await call("POST", `/v2/${NAME}/blobs/uploads/`, { headers: { "Content-Length": "0" } });
    const location = start.headers.get("Location")!;

    const response = await call("PATCH", location, {
      body: chunk2 as BodyInit,
      headers: { "Content-Length": "20", "Content-Range": "22-41" },
    });
    expect(response.status).toBe(416);
  });

  it("walks the full chunked upload, refusing a replayed chunk", async () => {
    const start = await call("POST", `/v2/${NAME}/blobs/uploads/`, { headers: { "Content-Length": "0" } });
    const location = start.headers.get("Location")!;

    const first = await call("PATCH", location, {
      body: chunk1 as BodyInit,
      headers: { "Content-Length": "22", "Content-Range": "0-21" },
    });
    expect(first.status).toBe(202);
    expect(first.headers.get("Range")).toBe("0-21");

    // Replaying the accepted chunk is out of order now.
    const replay = await call("PATCH", location, {
      body: chunk1 as BodyInit,
      headers: { "Content-Length": "22", "Content-Range": "0-21" },
    });
    expect(replay.status).toBe(416);

    // GET on a stale session reports where to resume.
    const status = await call("GET", location);
    expect(status.status).toBe(204);
    expect(status.headers.get("Location")).toBeTruthy();
    expect(status.headers.get("Range")).toBe("0-21");

    const second = await call("PATCH", location, {
      body: chunk2 as BodyInit,
      headers: { "Content-Length": "20", "Content-Range": "22-41" },
    });
    expect(second.status).toBe(202);
    expect(second.headers.get("Range")).toBe("0-41");

    const put = await call("PUT", `${location}?digest=${digest}`, { headers: { "Content-Length": "0" } });
    expect(put.status).toBe(201);

    const get = await call("GET", `/v2/${NAME}/blobs/${digest}`);
    expect(new Uint8Array(await get.arrayBuffer())).toEqual(content);
  });

  it("rejects a completed upload whose bytes do not hash to the promised digest", async () => {
    const start = await call("POST", `/v2/${NAME}/blobs/uploads/`);
    const location = start.headers.get("Location")!;
    await call("PATCH", location, { body: chunk1 as BodyInit, headers: { "Content-Length": "22" } });

    const put = await call("PUT", `${location}?digest=${DUMMY_DIGEST}`, {
      headers: { "Content-Length": "0" },
    });
    expect(put.status).toBe(400);
    expect(((await put.json()) as { errors: Array<{ code: string }> }).errors[0]!.code).toBe(
      "DIGEST_INVALID",
    );
  });

  it("404s a session that does not exist", async () => {
    expect((await call("GET", `/v2/${NAME}/blobs/uploads/nope`)).status).toBe(404);
  });
});

describe("push: chunked across R2 part boundaries", () => {
  // A tiny part size exercises the multipart path without allocating 5 MiB.
  const partSize = 1024;

  beforeEach(() => {
    registry = createTestRegistry({}, { partSize });
  });

  it("assembles a blob spanning many parts, with a ragged final part", async () => {
    const content = deterministic(partSize * 3 + 17, 5);
    const digest = digestOfBytes(content);

    const start = await call("POST", `/v2/${NAME}/blobs/uploads/`);
    const location = start.headers.get("Location")!;

    // Chunk sizes chosen to straddle part boundaries in every direction.
    let offset = 0;
    for (const size of [
      1,
      partSize - 1,
      partSize + 5,
      700,
      content.length - 1 - partSize * 2 - 5 - 700 + 1,
    ]) {
      const chunk = content.subarray(offset, offset + size);
      const response = await call("PATCH", location, {
        body: chunk as BodyInit,
        headers: {
          "Content-Length": String(chunk.length),
          "Content-Range": `${offset}-${offset + chunk.length - 1}`,
        },
      });
      expect(response.status, `chunk at ${offset}`).toBe(202);
      offset += chunk.length;
    }
    expect(offset).toBe(content.length);

    const put = await call("PUT", `${location}?digest=${digest}`, { headers: { "Content-Length": "0" } });
    expect(put.status).toBe(201);

    const get = await call("GET", `/v2/${NAME}/blobs/${digest}`);
    expect(new Uint8Array(await get.arrayBuffer())).toEqual(content);
  });

  it("handles a blob that is exactly one part long", async () => {
    const content = deterministic(partSize, 6);
    const digest = digestOfBytes(content);
    const start = await call("POST", `/v2/${NAME}/blobs/uploads/`);
    const location = start.headers.get("Location")!;

    await call("PATCH", location, {
      body: content as BodyInit,
      headers: { "Content-Length": String(partSize) },
    });
    expect(
      (await call("PUT", `${location}?digest=${digest}`, { headers: { "Content-Length": "0" } })).status,
    ).toBe(201);
    expect(new Uint8Array(await (await call("GET", `/v2/${NAME}/blobs/${digest}`)).arrayBuffer())).toEqual(
      content,
    );
  });

  it("handles an empty blob", async () => {
    const content = new Uint8Array(0);
    const digest = digestOfBytes(content);
    const start = await call("POST", `/v2/${NAME}/blobs/uploads/`);
    const location = start.headers.get("Location")!;
    expect(
      (await call("PUT", `${location}?digest=${digest}`, { headers: { "Content-Length": "0" } })).status,
    ).toBe(201);
  });

  it("uses the default 5 MiB part size", () => {
    expect(PART_SIZE).toBe(5 * 1024 * 1024);
  });
});

describe("cross-repository blob mount (end-11)", () => {
  it("opens a session when the blob is unknown", async () => {
    const response = await call("POST", `/v2/${CROSSMOUNT}/blobs/uploads/?mount=${DUMMY_DIGEST}`);
    expect(response.status).toBe(202);
    expect(response.headers.get("Location")).toMatch(new RegExp(`^/v2/${CROSSMOUNT}/blobs/uploads/`));
  });

  it("mounts a blob from another repository", async () => {
    const digest = await seedBlob(NAME, deterministic(42, 7));
    const response = await call("POST", `/v2/${CROSSMOUNT}/blobs/uploads/?mount=${digest}&from=${NAME}`);
    expect(response.status).toBe(201);
    expect(response.headers.get("Location")).toBe(`/v2/${CROSSMOUNT}/blobs/${digest}`);
    expect((await call("GET", `/v2/${CROSSMOUNT}/blobs/${digest}`)).status).toBe(200);
  });

  it("mounts without `from` when automatic cross-mount is enabled", async () => {
    const digest = await seedBlob(NAME, deterministic(42, 8));
    const response = await call("POST", `/v2/${CROSSMOUNT}/blobs/uploads/?mount=${digest}`);
    expect(response.status).toBe(201);
  });

  it("opens a session instead when automatic cross-mount is disabled", async () => {
    registry = createTestRegistry({ automaticCrossMount: false });
    const digest = await seedBlob(NAME, deterministic(42, 9));
    const response = await call("POST", `/v2/${CROSSMOUNT}/blobs/uploads/?mount=${digest}`);
    expect(response.status).toBe(202);
  });

  it("opens a session when the blob vanished between the lookup and the link", async () => {
    // Garbage collection may reclaim a blob while a mount is being authorised.
    // Handing back a 201 then would leave the repository pointing at nothing.
    const digest = await seedBlob(NAME, deterministic(42, 21));
    const metadata = registry.metadata;
    const original = metadata.linkBlob.bind(metadata);
    metadata.linkBlob = async () => false;

    const response = await call("POST", `/v2/${CROSSMOUNT}/blobs/uploads/?mount=${digest}&from=${NAME}`);
    expect(response.status).toBe(202);
    expect(response.headers.get("Location")).toMatch(new RegExp(`^/v2/${CROSSMOUNT}/blobs/uploads/`));

    metadata.linkBlob = original;
  });

  it("will not automatically mount a blob the caller cannot pull", async () => {
    // A blob living only in a private repository the caller has no access to
    // must not be mountable by digest alone - content addressing makes the
    // bytes identical everywhere, but the right to read them does not.
    registry = createTestRegistry(
      {},
      {
        authorize: async (repository, action) => {
          // The caller may push to their own repo but may not pull the victim's.
          if (repository === "victim/secret" && action === "pull") {
            throw new (await import("@registry/oci")).OciError("DENIED", "no access");
          }
        },
      },
    );
    const digest = await seedBlob("victim/secret", deterministic(42, 31));

    const response = await call("POST", `/v2/attacker/repo/blobs/uploads/?mount=${digest}`);
    expect(response.status).toBe(202);
    // And the blob is genuinely not readable from the attacker's repo.
    expect((await call("GET", `/v2/attacker/repo/blobs/${digest}`)).status).toBe(404);
  });

  it("automatically mounts a blob the caller could already pull", async () => {
    registry = createTestRegistry(); // permissive authorizer
    const digest = await seedBlob("public/base", deterministic(42, 32));
    const response = await call("POST", `/v2/myteam/app/blobs/uploads/?mount=${digest}`);
    expect(response.status).toBe(201);
    expect((await call("GET", `/v2/myteam/app/blobs/${digest}`)).status).toBe(200);
  });

  it("opens a session rather than failing when the caller cannot read `from`", async () => {
    registry = createTestRegistry(
      { automaticCrossMount: false },
      {
        authorize: async (repository) => {
          if (repository === NAME) throw new (await import("@registry/oci")).OciError("DENIED", "nope");
        },
      },
    );
    const response = await call(
      "POST",
      `/v2/${CROSSMOUNT}/blobs/uploads/?mount=${DUMMY_DIGEST}&from=${NAME}`,
    );
    expect(response.status).toBe(202);
  });
});

describe("manifest push validation (end-7)", () => {
  it("rejects a manifest whose blobs are absent", async () => {
    const { response } = await putManifest(NAME, "latest", manifestFor(DUMMY_DIGEST, 11));
    expect(response.status).toBe(400);
    expect(((await response.json()) as { errors: Array<{ code: string }> }).errors[0]!.code).toBe(
      "MANIFEST_BLOB_UNKNOWN",
    );
  });

  it("accepts a manifest with no layers", async () => {
    const config = bytes(7);
    const configDigest = await seedBlob(NAME, config);
    // No `mediaType` in the body: it must be taken from Content-Type.
    const document = {
      schemaVersion: 2,
      config: { mediaType: "application/vnd.oci.image.config.v1+json", digest: configDigest, size: 1 },
      layers: [],
    };
    const { response } = await putManifest(NAME, "emptylayer", document);
    expect(response.status).toBe(201);
  });

  it("rejects a digest reference that disagrees with the body", async () => {
    const config = bytes(7);
    const configDigest = await seedBlob(NAME, config);
    const { response } = await putManifest(NAME, DUMMY_DIGEST, manifestFor(configDigest, 1));
    expect(response.status).toBe(400);
    expect(((await response.json()) as { errors: Array<{ code: string }> }).errors[0]!.code).toBe(
      "DIGEST_INVALID",
    );
  });

  it("rejects a manifest larger than the configured limit with 413", async () => {
    registry = createTestRegistry({ maxManifestSize: 128 });
    const body = new TextEncoder().encode(JSON.stringify({ schemaVersion: 2, padding: "x".repeat(200) }));
    const response = await call("PUT", `/v2/${NAME}/manifests/latest`, {
      body: body as BodyInit,
      headers: { "Content-Type": MEDIA_TYPE_OCI_MANIFEST, "Content-Length": String(body.length) },
    });
    expect(response.status).toBe(413);
  });

  it("accepts an index whose children exist and does not check them by default", async () => {
    const document = {
      schemaVersion: 2,
      mediaType: MEDIA_TYPE_OCI_INDEX,
      manifests: [{ mediaType: MEDIA_TYPE_OCI_MANIFEST, digest: DUMMY_DIGEST, size: 10 }],
    };
    const { response } = await putManifest(NAME, "index", document, MEDIA_TYPE_OCI_INDEX);
    expect(response.status).toBe(201);
  });

  it("checks index children when configured to", async () => {
    registry = createTestRegistry({ validateManifestReferences: true });
    const document = {
      schemaVersion: 2,
      mediaType: MEDIA_TYPE_OCI_INDEX,
      manifests: [{ mediaType: MEDIA_TYPE_OCI_MANIFEST, digest: DUMMY_DIGEST, size: 10 }],
    };
    const { response } = await putManifest(NAME, "index", document, MEDIA_TYPE_OCI_INDEX);
    expect(response.status).toBe(400);
  });
});

describe("tag listing (end-8a, end-8b)", () => {
  beforeEach(async () => {
    const config = bytes(3);
    const configDigest = await seedBlob(NAME, config);
    for (const tag of ["test0", "test1", "test2", "test3"]) {
      await putManifest(NAME, tag, manifestFor(configDigest, 1));
    }
  });

  it("404s an unknown repository", async () => {
    const response = await call("GET", "/v2/unknown/repo/tags/list");
    expect(response.status).toBe(404);
    expect(((await response.json()) as { errors: Array<{ code: string }> }).errors[0]!.code).toBe(
      "NAME_UNKNOWN",
    );
  });

  it("lists tags in lexical order", async () => {
    const response = await call("GET", `/v2/${NAME}/tags/list`);
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ name: NAME, tags: ["test0", "test1", "test2", "test3"] });
  });

  it("limits with `n` and advertises the next page", async () => {
    const response = await call("GET", `/v2/${NAME}/tags/list?n=2`);
    expect(((await response.clone().json()) as { tags: string[] }).tags).toEqual(["test0", "test1"]);
    expect(response.headers.get("Link")).toBe(`</v2/${NAME}/tags/list?n=2&last=test1>; rel="next"`);
  });

  it("resumes after `last`", async () => {
    const response = await call("GET", `/v2/${NAME}/tags/list?n=2&last=test1`);
    expect(((await response.json()) as { tags: string[] }).tags).toEqual(["test2", "test3"]);
  });

  it("returns an empty list and no Link when n=0", async () => {
    const response = await call("GET", `/v2/${NAME}/tags/list?n=0`);
    expect(await response.json()).toEqual({ name: NAME, tags: [] });
    expect(response.headers.get("Link")).toBeNull();
  });

  it("rejects a malformed `n`", async () => {
    expect((await call("GET", `/v2/${NAME}/tags/list?n=-1`)).status).toBe(400);
    expect((await call("GET", `/v2/${NAME}/tags/list?n=abc`)).status).toBe(400);
  });
});

describe("referrers (end-12a, end-12b)", () => {
  const ARTIFACT_A = "application/vnd.nhl.peanut.butter.bagel";
  const ARTIFACT_B = "application/vnd.nba.strawberry.jam.croissant";
  const ANNOTATION = "org.opencontainers.conformance.test";

  let subjectDigest: string;
  let subjectSize: number;

  beforeEach(async () => {
    const config = bytes(1, 2);
    const configDigest = await seedBlob(NAME, config);
    const subject = await putManifest(NAME, "tagtest0", manifestFor(configDigest, 2));
    expect(subject.response.status).toBe(201);
    subjectDigest = subject.digest;
    subjectSize = subject.size;
  });

  const subjectDescriptor = () => ({
    mediaType: MEDIA_TYPE_OCI_MANIFEST,
    digest: subjectDigest,
    size: subjectSize,
  });

  it("returns an empty index, not a 404, for an unreferenced subject", async () => {
    const response = await call("GET", `/v2/${NAME}/referrers/${DUMMY_DIGEST}`);
    expect(response.status).toBe(200);
    expect(response.headers.get("Content-Type")).toBe(MEDIA_TYPE_OCI_INDEX);
    expect(await response.json()).toEqual({
      schemaVersion: 2,
      mediaType: MEDIA_TYPE_OCI_INDEX,
      manifests: [],
    });
  });

  it("returns an empty index for a repository that does not exist", async () => {
    const response = await call("GET", `/v2/does/not/exist/referrers/${DUMMY_DIGEST}`);
    expect(response.status).toBe(200);
    expect(((await response.json()) as { manifests: unknown[] }).manifests).toEqual([]);
  });

  it("400s a malformed digest", async () => {
    expect((await call("GET", `/v2/${NAME}/referrers/sha256:totallywrong`)).status).toBe(400);
  });

  it("sets OCI-Subject when a manifest carries a subject", async () => {
    const blob = new TextEncoder().encode("NHL Peanut Butter on my NHL bagel");
    const blobDigest = await seedBlob(NAME, blob);
    const { response } = await putManifest(NAME, "referrer", {
      schemaVersion: 2,
      mediaType: MEDIA_TYPE_OCI_MANIFEST,
      config: { mediaType: ARTIFACT_A, digest: blobDigest, size: blob.length },
      layers: [],
      subject: subjectDescriptor(),
      annotations: { [ANNOTATION]: "test config a" },
    });
    expect(response.status).toBe(201);
    expect(response.headers.get("OCI-Subject")).toBe(subjectDigest);
  });

  it("accepts a referrer whose subject has not been pushed", async () => {
    const { response } = await putManifest(NAME, "orphan", {
      schemaVersion: 2,
      mediaType: MEDIA_TYPE_OCI_MANIFEST,
      artifactType: ARTIFACT_B,
      config: {
        mediaType: "application/vnd.oci.empty.v1+json",
        digest: await seedBlob(NAME, bytes(123, 125)),
        size: 2,
      },
      layers: [],
      subject: { mediaType: MEDIA_TYPE_OCI_MANIFEST, digest: DUMMY_DIGEST, size: 99 },
    });
    expect(response.status).toBe(201);

    const listing = await call("GET", `/v2/${NAME}/referrers/${DUMMY_DIGEST}`);
    expect(((await listing.json()) as { manifests: unknown[] }).manifests).toHaveLength(1);
  });

  it("derives artifactType from the config media type, and filters on it", async () => {
    const blobA = new TextEncoder().encode("NHL Peanut Butter on my NHL bagel");
    const blobADigest = await seedBlob(NAME, blobA);
    const emptyDigest = await seedBlob(NAME, new TextEncoder().encode("{}"));

    // Config-derived artifactType.
    await putManifest(NAME, "ref-a-config", {
      schemaVersion: 2,
      mediaType: MEDIA_TYPE_OCI_MANIFEST,
      config: { mediaType: ARTIFACT_A, digest: blobADigest, size: blobA.length },
      layers: [{ mediaType: "application/vnd.oci.empty.v1+json", digest: emptyDigest, size: 2 }],
      subject: subjectDescriptor(),
      annotations: { [ANNOTATION]: "test config a" },
    });

    // Explicit artifactType.
    await putManifest(NAME, "ref-a-layer", {
      schemaVersion: 2,
      mediaType: MEDIA_TYPE_OCI_MANIFEST,
      artifactType: ARTIFACT_A,
      config: { mediaType: "application/vnd.oci.empty.v1+json", digest: emptyDigest, size: 2 },
      layers: [{ mediaType: ARTIFACT_A, digest: blobADigest, size: blobA.length }],
      subject: subjectDescriptor(),
      annotations: { [ANNOTATION]: "test layer a" },
    });

    // A different artifact type, which the filter must exclude.
    await putManifest(NAME, "ref-b", {
      schemaVersion: 2,
      mediaType: MEDIA_TYPE_OCI_MANIFEST,
      artifactType: ARTIFACT_B,
      config: { mediaType: "application/vnd.oci.empty.v1+json", digest: emptyDigest, size: 2 },
      layers: [],
      subject: subjectDescriptor(),
      annotations: { [ANNOTATION]: "test layer b" },
    });

    // An index with its own artifactType.
    await putManifest(
      NAME,
      "ref-index",
      {
        schemaVersion: 2,
        mediaType: MEDIA_TYPE_OCI_INDEX,
        artifactType: "application/vnd.food.stand",
        manifests: [],
        subject: subjectDescriptor(),
        annotations: { [ANNOTATION]: "test index" },
      },
      MEDIA_TYPE_OCI_INDEX,
    );

    const all = await call("GET", `/v2/${NAME}/referrers/${subjectDigest}`);
    const listing = (await all.json()) as {
      manifests: Array<{ artifactType?: string; annotations?: Record<string, string>; mediaType: string }>;
    };
    expect(listing.manifests).toHaveLength(4);
    for (const descriptor of listing.manifests) {
      expect(Object.keys(descriptor.annotations ?? {})).toHaveLength(1);
    }
    expect(listing.manifests.filter((d) => d.artifactType === ARTIFACT_A)).toHaveLength(2);
    expect(listing.manifests.find((d) => d.mediaType === MEDIA_TYPE_OCI_INDEX)?.artifactType).toBe(
      "application/vnd.food.stand",
    );

    const filtered = await call("GET", `/v2/${NAME}/referrers/${subjectDigest}?artifactType=${ARTIFACT_A}`);
    expect(filtered.headers.get("OCI-Filters-Applied")).toBe("artifactType");
    expect(((await filtered.json()) as { manifests: unknown[] }).manifests).toHaveLength(2);
  });

  it("omits artifactType for an index that declares none", async () => {
    await putManifest(
      NAME,
      "plain-index",
      {
        schemaVersion: 2,
        mediaType: MEDIA_TYPE_OCI_INDEX,
        manifests: [],
        subject: subjectDescriptor(),
      },
      MEDIA_TYPE_OCI_INDEX,
    );
    const response = await call("GET", `/v2/${NAME}/referrers/${subjectDigest}`);
    const listing = (await response.json()) as { manifests: Array<Record<string, unknown>> };
    expect(listing.manifests[0]).not.toHaveProperty("artifactType");
    expect(listing.manifests[0]).not.toHaveProperty("annotations");
  });
});

describe("content management (end-9, end-10)", () => {
  it("deletes a tag, leaving the manifest reachable by digest", async () => {
    const configDigest = await seedBlob(NAME, bytes(5));
    const { digest } = await putManifest(NAME, "tagtest0", manifestFor(configDigest, 1));

    expect((await call("DELETE", `/v2/${NAME}/manifests/tagtest0`)).status).toBe(202);
    expect((await call("GET", `/v2/${NAME}/manifests/tagtest0`)).status).toBe(404);
    expect((await call("GET", `/v2/${NAME}/manifests/${digest}`)).status).toBe(200);
    expect(((await (await call("GET", `/v2/${NAME}/tags/list`)).json()) as { tags: string[] }).tags).toEqual(
      [],
    );
  });

  it("deletes a manifest by digest, taking its tags with it", async () => {
    const configDigest = await seedBlob(NAME, bytes(6));
    const { digest } = await putManifest(NAME, "tagtest0", manifestFor(configDigest, 1));
    await putManifest(NAME, "second", manifestFor(configDigest, 1));

    expect((await call("DELETE", `/v2/${NAME}/manifests/${digest}`)).status).toBe(202);
    expect((await call("GET", `/v2/${NAME}/manifests/${digest}`)).status).toBe(404);
    expect((await call("GET", `/v2/${NAME}/manifests/tagtest0`)).status).toBe(404);
    expect((await call("GET", `/v2/${NAME}/manifests/second`)).status).toBe(404);
  });

  it("404s deleting a manifest twice", async () => {
    const configDigest = await seedBlob(NAME, bytes(8));
    const { digest } = await putManifest(NAME, "tagtest0", manifestFor(configDigest, 1));
    expect((await call("DELETE", `/v2/${NAME}/manifests/${digest}`)).status).toBe(202);
    expect((await call("DELETE", `/v2/${NAME}/manifests/${digest}`)).status).toBe(404);
  });

  it("unlinks a blob from one repository without disturbing another", async () => {
    const content = deterministic(30, 11);
    const digest = await seedBlob(NAME, content);
    await call("POST", `/v2/${CROSSMOUNT}/blobs/uploads/?mount=${digest}&from=${NAME}`);

    expect((await call("DELETE", `/v2/${NAME}/blobs/${digest}`)).status).toBe(202);
    expect((await call("GET", `/v2/${NAME}/blobs/${digest}`)).status).toBe(404);
    // Deduplicated content stays readable wherever it is still linked.
    expect((await call("GET", `/v2/${CROSSMOUNT}/blobs/${digest}`)).status).toBe(200);
  });

  it("404s deleting an unknown blob", async () => {
    expect((await call("DELETE", `/v2/${NAME}/blobs/${DUMMY_DIGEST}`)).status).toBe(404);
  });

  it("answers 400 UNSUPPORTED when deletes are disabled", async () => {
    registry = createTestRegistry({ enableDeletes: false });
    const configDigest = await seedBlob(NAME, bytes(9));
    const { digest } = await putManifest(NAME, "tagtest0", manifestFor(configDigest, 1));

    const response = await call("DELETE", `/v2/${NAME}/manifests/${digest}`);
    expect(response.status).toBe(400);
    expect(((await response.json()) as { errors: Array<{ code: string }> }).errors[0]!.code).toBe(
      "UNSUPPORTED",
    );
  });
});

describe("deduplication", () => {
  it("stores identical content once and links it from both repositories", async () => {
    const content = deterministic(50, 12);
    const digest = await seedBlob(NAME, content);
    await seedBlob(CROSSMOUNT, content);

    const stored = [...registry.content.objects.keys()].filter((key) => key.startsWith("blobs/"));
    expect(stored).toEqual([`blobs/sha256/${sha256Hex(content)}`]);

    expect((await call("GET", `/v2/${NAME}/blobs/${digest}`)).status).toBe(200);
    expect((await call("GET", `/v2/${CROSSMOUNT}/blobs/${digest}`)).status).toBe(200);
  });

  it("drops the losing object when two uploads race to store the same digest", async () => {
    // A chunked upload lands at a staging key; a later identical upload finds
    // the digest already registered and must delete what it just wrote.
    registry = createTestRegistry({}, { partSize: 16 });
    const content = deterministic(40, 13);
    const digest = digestOfBytes(content);

    for (const repository of [NAME, CROSSMOUNT]) {
      const start = await call("POST", `/v2/${repository}/blobs/uploads/`);
      const location = start.headers.get("Location")!;
      await call("PATCH", location, { body: content as BodyInit, headers: { "Content-Length": "40" } });
      expect(
        (await call("PUT", `${location}?digest=${digest}`, { headers: { "Content-Length": "0" } })).status,
      ).toBe(201);
    }

    const staged = [...registry.content.objects.keys()].filter((key) => key.startsWith("blobs/staged/"));
    expect(staged).toHaveLength(1);
    expect((await call("GET", `/v2/${NAME}/blobs/${digest}`)).status).toBe(200);
    expect((await call("GET", `/v2/${CROSSMOUNT}/blobs/${digest}`)).status).toBe(200);
  });
});

describe("authorization", () => {
  it("propagates a 401 from the authorizer", async () => {
    const { OciError } = await import("@registry/oci");
    registry = createTestRegistry(
      {},
      {
        authorize: async () => {
          throw new OciError("UNAUTHORIZED", "authentication required", {
            headers: { "WWW-Authenticate": 'Bearer realm="https://registry.example.com/token"' },
          });
        },
      },
    );

    const response = await call("GET", "/v2/");
    expect(response.status).toBe(401);
    expect(response.headers.get("WWW-Authenticate")).toContain("Bearer");
  });
});

describe("method handling", () => {
  it("405s an unsupported method", async () => {
    expect((await call("POST", `/v2/${NAME}/manifests/latest`)).status).toBe(405);
    expect((await call("PUT", `/v2/${NAME}/tags/list`)).status).toBe(405);
  });

  it("returns null for paths outside /v2", async () => {
    const response = await handleRegistryRequest(new Request(`${BASE}/healthz`), registry);
    expect(response).toBeNull();
  });
});
