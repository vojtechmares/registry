import { describe, expect, it } from "vitest";
import {
  digestEquals,
  digestOf,
  digestOfAsync,
  isSupportedAlgorithm,
  isValidDigest,
  looksLikeDigest,
  parseDigest,
  referrersTag,
} from "./digest.js";

const SHA256_ZERO = "sha256:e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855";

describe("looksLikeDigest", () => {
  it("treats any reference containing a colon as a digest", () => {
    // A tag may not contain ":", so the colon alone decides. This is what lets
    // `sha256:totallywrong` fail as a digest (400) while `.INVALID_MANIFEST_NAME`
    // fails as a tag (404) - the conformance suite requires both.
    expect(looksLikeDigest("sha256:totallywrong")).toBe(true);
    expect(looksLikeDigest(SHA256_ZERO)).toBe(true);
    expect(looksLikeDigest(".INVALID_MANIFEST_NAME")).toBe(false);
    expect(looksLikeDigest("latest")).toBe(false);
  });
});

describe("parseDigest", () => {
  it("splits on the first colon", () => {
    expect(parseDigest(SHA256_ZERO)).toEqual({
      algorithm: "sha256",
      encoded: "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
    });
  });

  it("accepts multi-component algorithms per the grammar", () => {
    expect(parseDigest("multihash+base58:QmRZxt2b1FVZPNqd8hsiykDL3TdBDeTSPX9Kv46HmX4Gx8")).toEqual({
      algorithm: "multihash+base58",
      encoded: "QmRZxt2b1FVZPNqd8hsiykDL3TdBDeTSPX9Kv46HmX4Gx8",
    });
  });

  it("rejects grammar violations", () => {
    expect(parseDigest("sha256")).toBeNull();
    expect(parseDigest(":abc")).toBeNull();
    expect(parseDigest("sha256:")).toBeNull();
    expect(parseDigest("SHA256:abc")).toBeNull();
    expect(parseDigest("sha256:abc!")).toBeNull();
  });
});

describe("isValidDigest", () => {
  it("accepts sha256 at its exact encoded length", () => {
    expect(isValidDigest(SHA256_ZERO)).toBe(true);
  });

  it("rejects a well-formed digest whose encoding is wrong for the algorithm", () => {
    expect(isValidDigest("sha256:totallywrong")).toBe(false);
    expect(isValidDigest(`sha256:${"a".repeat(63)}`)).toBe(false);
    expect(isValidDigest(`sha256:${"a".repeat(65)}`)).toBe(false);
    expect(isValidDigest(`sha256:${"A".repeat(64)}`)).toBe(false);
  });

  it("rejects algorithms the registry cannot verify, sha512 included", () => {
    // The grammar permits sha512, but nothing here can hash it, so accepting it
    // would promise verification the registry cannot deliver.
    expect(isValidDigest(`sha512:${"a".repeat(128)}`)).toBe(false);
    expect(isValidDigest(`sha1:${"a".repeat(40)}`)).toBe(false);
    expect(isSupportedAlgorithm("sha256")).toBe(true);
    expect(isSupportedAlgorithm("sha512")).toBe(false);
    expect(isSupportedAlgorithm("md5")).toBe(false);
  });
});

describe("digestOf", () => {
  it("agrees with the async Web Crypto path", async () => {
    const data = new TextEncoder().encode("hello world");
    expect(digestOf(data)).toBe("sha256:b94d27b9934d3e08a52e52d7da7dabfac484efe37a5380ee9088f7ace2efcde9");
    expect(await digestOfAsync(data)).toBe(digestOf(data));
  });
});

describe("digestEquals", () => {
  it("compares without early exit", () => {
    expect(digestEquals(SHA256_ZERO, SHA256_ZERO)).toBe(true);
    expect(digestEquals(SHA256_ZERO, SHA256_ZERO.replace(/5$/, "6"))).toBe(false);
    expect(digestEquals(SHA256_ZERO, "sha256:short")).toBe(false);
  });
});

describe("referrersTag", () => {
  it("maps a subject digest onto the fallback tag schema", () => {
    expect(referrersTag(`sha256:${"a".repeat(64)}`)).toBe(`sha256-${"a".repeat(64)}`);
  });
});
