import { describe, expect, it } from "vitest";
import { matchRoute } from "./router.js";

const digest = `sha256:${"a".repeat(64)}`;

describe("matchRoute", () => {
  it("matches the base endpoint with or without a trailing slash", () => {
    expect(matchRoute("/v2")).toEqual({ kind: "base" });
    expect(matchRoute("/v2/")).toEqual({ kind: "base" });
  });

  it("returns null outside the /v2 namespace", () => {
    expect(matchRoute("/")).toBeNull();
    expect(matchRoute("/v1/foo")).toBeNull();
    expect(matchRoute("/v2foo/bar")).toBeNull();
  });

  it("absorbs slashes in the repository name", () => {
    expect(matchRoute(`/v2/library/ubuntu/blobs/${digest}`)).toEqual({
      kind: "blob",
      name: "library/ubuntu",
      digest,
    });
    expect(matchRoute("/v2/a/b/c/d/tags/list")).toEqual({ kind: "tags", name: "a/b/c/d" });
  });

  it("prefers the uploads route over reading `uploads` as a digest", () => {
    expect(matchRoute("/v2/repo/blobs/uploads/")).toEqual({ kind: "uploads", name: "repo" });
    expect(matchRoute("/v2/repo/blobs/uploads/session-id")).toEqual({
      kind: "upload",
      name: "repo",
      id: "session-id",
    });
    // Without the trailing slash and without a session id, `uploads` is a digest
    // position - the digest is then rejected by validation, not by routing.
    expect(matchRoute("/v2/repo/blobs/uploads")).toEqual({ kind: "blob", name: "repo", digest: "uploads" });
  });

  it("matches manifests by tag and by digest", () => {
    expect(matchRoute("/v2/repo/manifests/latest")).toEqual({
      kind: "manifest",
      name: "repo",
      reference: "latest",
    });
    expect(matchRoute(`/v2/repo/manifests/${digest}`)).toEqual({
      kind: "manifest",
      name: "repo",
      reference: digest,
    });
    expect(matchRoute("/v2/repo/manifests/sha256:totallywrong")).toEqual({
      kind: "manifest",
      name: "repo",
      reference: "sha256:totallywrong",
    });
  });

  it("matches referrers", () => {
    expect(matchRoute(`/v2/repo/referrers/${digest}`)).toEqual({ kind: "referrers", name: "repo", digest });
  });

  it("resolves a repository whose last component collides with a route keyword", () => {
    // Greedy matching hands `blobs` to the name, which is what a client pushing
    // to `myorg/blobs` expects.
    expect(matchRoute(`/v2/myorg/blobs/blobs/${digest}`)).toEqual({
      kind: "blob",
      name: "myorg/blobs",
      digest,
    });
    expect(matchRoute("/v2/myorg/manifests/manifests/latest")).toEqual({
      kind: "manifest",
      name: "myorg/manifests",
      reference: "latest",
    });
  });

  it("returns null for unknown shapes", () => {
    expect(matchRoute("/v2/repo/unknown/thing")).toBeNull();
    expect(matchRoute("/v2/repo/tags/list/extra")).toBeNull();
  });
});
