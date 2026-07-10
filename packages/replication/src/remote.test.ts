import { describe, expect, it, vi } from "vitest";
import { RemoteRegistry, parseChallenge } from "./remote.js";

describe("parseChallenge", () => {
  it("reads realm, service and scope", () => {
    const challenge = parseChallenge(
      'Bearer realm="https://auth.docker.io/token",service="registry.docker.io",scope="repository:library/alpine:pull"',
    );
    expect(challenge).toEqual({
      realm: "https://auth.docker.io/token",
      service: "registry.docker.io",
      scope: "repository:library/alpine:pull",
    });
  });

  it("tolerates a challenge with only a realm", () => {
    expect(parseChallenge('Bearer realm="https://auth.example.com/token"')).toEqual({
      realm: "https://auth.example.com/token",
      service: null,
      scope: null,
    });
  });

  it("rejects a Basic challenge and anything malformed", () => {
    expect(parseChallenge('Basic realm="registry"')).toBeNull();
    expect(parseChallenge("Bearer")).toBeNull();
    expect(parseChallenge('Bearer service="x"')).toBeNull();
  });
});

interface Call {
  url: string;
  method: string;
  authorization: string | null;
}

/** A fake registry that challenges once, then serves. */
function fakeRegistry(handler: (url: URL, init: RequestInit, calls: Call[]) => Response) {
  const calls: Call[] = [];
  const fetcher = vi.fn(async (input: RequestInfo | URL, init: RequestInit = {}) => {
    const url = new URL(String(input));
    calls.push({
      url: url.toString(),
      method: init.method ?? "GET",
      authorization: new Headers(init.headers).get("Authorization"),
    });
    return handler(url, init, calls);
  });
  return { fetcher: fetcher as unknown as typeof fetch, calls };
}

const MANIFEST = JSON.stringify({
  schemaVersion: 2,
  mediaType: "application/vnd.oci.image.manifest.v1+json",
  config: { mediaType: "application/vnd.oci.image.config.v1+json", digest: "sha256:c", size: 1 },
  layers: [],
});

describe("RemoteRegistry authentication", () => {
  it("answers a bearer challenge and retries once", async () => {
    const { fetcher, calls } = fakeRegistry((url) => {
      if (url.pathname === "/token") return Response.json({ token: "issued-token" });
      if (calls.filter((call) => call.url.includes("/manifests/")).length === 1) {
        return new Response(null, {
          status: 401,
          headers: { "WWW-Authenticate": 'Bearer realm="https://auth.test/token",service="reg"' },
        });
      }
      return new Response(MANIFEST, {
        headers: { "Content-Type": "application/vnd.oci.image.manifest.v1+json" },
      });
    });

    const remote = new RemoteRegistry({ url: "https://reg.test", fetch: fetcher });
    const manifest = await remote.getManifest("library/alpine", "latest");
    expect(manifest?.mediaType).toBe("application/vnd.oci.image.manifest.v1+json");

    const retry = calls.at(-1)!;
    expect(retry.authorization).toBe("Bearer issued-token");
  });

  it("sends credentials to the token endpoint, never to the registry", async () => {
    const { fetcher, calls } = fakeRegistry((url, _init, seen) => {
      if (url.pathname === "/token") return Response.json({ token: "t" });
      if (seen.filter((call) => call.url.includes("/manifests/")).length === 1) {
        return new Response(null, {
          status: 401,
          headers: { "WWW-Authenticate": 'Bearer realm="https://auth.test/token"' },
        });
      }
      return new Response(MANIFEST, { headers: { "Content-Type": "application/json" } });
    });

    const remote = new RemoteRegistry({
      url: "https://reg.test",
      credentials: { username: "alice", password: "hunter2" },
      fetch: fetcher,
    });
    await remote.getManifest("library/alpine", "latest");

    const tokenCall = calls.find((call) => call.url.includes("/token"))!;
    expect(tokenCall.authorization).toBe(`Basic ${btoa("alice:hunter2")}`);

    // The registry itself only ever sees the bearer token.
    const registryCalls = calls.filter((call) => call.url.includes("/manifests/"));
    expect(registryCalls.every((call) => call.authorization !== `Basic ${btoa("alice:hunter2")}`)).toBe(true);
  });

  it("falls back to Basic when the challenge is not a bearer one", async () => {
    const { fetcher, calls } = fakeRegistry((_url, _init, seen) => {
      if (seen.length === 1) {
        return new Response(null, { status: 401, headers: { "WWW-Authenticate": 'Basic realm="reg"' } });
      }
      return new Response(MANIFEST, { headers: { "Content-Type": "application/json" } });
    });

    const remote = new RemoteRegistry({
      url: "https://reg.test",
      credentials: { username: "alice", password: "hunter2" },
      fetch: fetcher,
    });
    await remote.getManifest("acme/api", "v1");
    expect(calls.at(-1)!.authorization).toBe(`Basic ${btoa("alice:hunter2")}`);
  });

  it("does not retry forever against a registry that challenges its own token", async () => {
    const { fetcher, calls } = fakeRegistry((url) => {
      if (url.pathname === "/token") return Response.json({ token: "t" });
      return new Response(null, {
        status: 401,
        headers: { "WWW-Authenticate": 'Bearer realm="https://auth.test/token"' },
      });
    });

    const remote = new RemoteRegistry({ url: "https://reg.test", fetch: fetcher });
    await expect(remote.getManifest("acme/api", "v1")).rejects.toThrow(/401/);
    // One attempt, one token fetch, one retry.
    expect(calls).toHaveLength(3);
  });
});

describe("RemoteRegistry operations", () => {
  it("reports a missing manifest as null rather than as an error", async () => {
    const { fetcher } = fakeRegistry(() => new Response(null, { status: 404 }));
    const remote = new RemoteRegistry({ url: "https://reg.test", fetch: fetcher });
    expect(await remote.getManifest("acme/api", "nope")).toBeNull();
  });

  it("computes the digest itself when the registry does not send one", async () => {
    const { fetcher } = fakeRegistry(
      () => new Response(MANIFEST, { headers: { "Content-Type": "application/json" } }),
    );
    const remote = new RemoteRegistry({ url: "https://reg.test", fetch: fetcher });
    const manifest = await remote.getManifest("acme/api", "v1");
    expect(manifest?.digest).toMatch(/^sha256:[a-f0-9]{64}$/);
  });

  it("strips parameters from the returned media type", async () => {
    const { fetcher } = fakeRegistry(
      () =>
        new Response(MANIFEST, {
          headers: { "Content-Type": "application/vnd.oci.image.manifest.v1+json; charset=utf-8" },
        }),
    );
    const remote = new RemoteRegistry({ url: "https://reg.test", fetch: fetcher });
    const manifest = await remote.getManifest("acme/api", "v1");
    expect(manifest?.mediaType).toBe("application/vnd.oci.image.manifest.v1+json");
  });

  it("uploads a blob by opening a session and closing it with the digest", async () => {
    const { fetcher, calls } = fakeRegistry((url) => {
      if (url.pathname.endsWith("/blobs/uploads/")) {
        return new Response(null, { status: 202, headers: { Location: "/v2/acme/api/blobs/uploads/abc" } });
      }
      return new Response(null, { status: 201 });
    });

    const remote = new RemoteRegistry({ url: "https://reg.test", fetch: fetcher });
    await remote.putBlob("acme/api", "sha256:deadbeef", {
      size: 3,
      body: new Response(new Uint8Array([1, 2, 3])).body!,
    });

    expect(calls[0]?.method).toBe("POST");
    expect(calls[1]?.method).toBe("PUT");
    expect(calls[1]?.url).toContain("digest=sha256%3Adeadbeef");
  });

  it("buffers a blob whose size the source would not report", async () => {
    const { fetcher, calls } = fakeRegistry((url) => {
      if (url.pathname.endsWith("/blobs/uploads/")) {
        return new Response(null, { status: 202, headers: { Location: "/v2/acme/api/blobs/uploads/abc" } });
      }
      return new Response(null, { status: 201 });
    });

    const remote = new RemoteRegistry({ url: "https://reg.test", fetch: fetcher });
    await remote.putBlob("acme/api", "sha256:x", {
      size: -1,
      body: new Response(new Uint8Array([1, 2, 3, 4])).body!,
    });
    expect(calls[1]?.method).toBe("PUT");
  });

  it("reads an absolute upload Location as well as a relative one", async () => {
    const { fetcher, calls } = fakeRegistry((url) => {
      if (url.pathname.endsWith("/blobs/uploads/")) {
        return new Response(null, {
          status: 202,
          headers: { Location: "https://reg.test/v2/acme/api/blobs/uploads/xyz" },
        });
      }
      return new Response(null, { status: 201 });
    });

    const remote = new RemoteRegistry({ url: "https://reg.test", fetch: fetcher });
    await remote.putBlob("acme/api", "sha256:y", { size: 1, body: new Response(new Uint8Array([1])).body! });
    expect(calls[1]?.url).toContain("/v2/acme/api/blobs/uploads/xyz");
  });

  it("lists tags, and reads an empty listing as empty rather than as null", async () => {
    const { fetcher } = fakeRegistry(() => Response.json({ name: "acme/api", tags: null }));
    const remote = new RemoteRegistry({ url: "https://reg.test", fetch: fetcher });
    expect(await remote.listTags("acme/api")).toEqual([]);
  });
});

const publicOnly = (url: string) => new URL(url).hostname !== "169.254.169.254";

describe("RemoteRegistry SSRF guard", () => {
  it("refuses a base URL the guard rejects, at construction", () => {
    expect(
      () =>
        new RemoteRegistry({
          url: "https://169.254.169.254",
          guard: publicOnly,
          fetch: async () => new Response(),
        }),
    ).toThrow(/refusing/);
  });

  it("follows a redirect to a public host, which is how a blob reaches its CDN", async () => {
    let hop = 0;
    const fetcher = vi.fn(async () => {
      hop++;
      if (hop === 1) {
        return new Response(null, { status: 302, headers: { Location: "https://cdn.test/blob" } });
      }
      return new Response(new Uint8Array([1, 2, 3]), { headers: { "Content-Length": "3" } });
    }) as unknown as typeof fetch;

    const remote = new RemoteRegistry({ url: "https://reg.test", guard: () => true, fetch: fetcher });
    const blob = await remote.getBlob("acme/api", "sha256:x");
    expect(blob).not.toBeNull();
    expect(hop).toBe(2);
  });

  it("refuses a redirect that points at an internal address", async () => {
    const fetcher = vi.fn(
      async () =>
        new Response(null, { status: 302, headers: { Location: "https://169.254.169.254/latest" } }),
    ) as unknown as typeof fetch;

    const remote = new RemoteRegistry({ url: "https://reg.test", guard: publicOnly, fetch: fetcher });
    await expect(remote.getManifest("acme/api", "v1")).rejects.toThrow(/refusing/);
  });

  it("refuses a token realm that points at an internal address", async () => {
    const fetcher = vi.fn(async (input: RequestInfo | URL) => {
      const url = new URL(String(input));
      if (url.hostname === "reg.test") {
        return new Response(null, {
          status: 401,
          headers: { "WWW-Authenticate": 'Bearer realm="https://169.254.169.254/token"' },
        });
      }
      return Response.json({ token: "t" });
    }) as unknown as typeof fetch;

    const remote = new RemoteRegistry({
      url: "https://reg.test",
      credentials: { username: "a", password: "b" },
      guard: publicOnly,
      fetch: fetcher,
    });
    // The realm fetch is refused, so no token is obtained and the 401 stands.
    await expect(remote.getManifest("acme/api", "v1")).rejects.toThrow(/refusing/);
  });

  it("gives up rather than following a redirect loop forever", async () => {
    const fetcher = vi.fn(
      async () => new Response(null, { status: 302, headers: { Location: "https://reg.test/again" } }),
    ) as unknown as typeof fetch;

    const remote = new RemoteRegistry({ url: "https://reg.test", guard: () => true, fetch: fetcher });
    await expect(remote.getManifest("acme/api", "v1")).rejects.toThrow(/too many redirects/);
  });
});
