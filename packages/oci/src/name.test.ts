import { describe, expect, it } from "vitest";
import { MAX_NAME_LENGTH, isValidRepositoryName, isValidTag } from "./name.js";

describe("isValidRepositoryName", () => {
  it("accepts the shapes the spec's regex allows", () => {
    for (const name of [
      "ubuntu",
      "library/ubuntu",
      "a/b/c/d",
      "my-repo",
      "my--repo",
      "my---repo",
      "my.repo",
      "my_repo",
      "my__repo",
      "0",
      "conformance-2f5b9b4e-0000-4000-8000-000000000000",
    ]) {
      expect(isValidRepositoryName(name), name).toBe(true);
    }
  });

  it("rejects uppercase, leading and trailing separators, and empty components", () => {
    for (const name of [
      "",
      "Ubuntu",
      "-ubuntu",
      "ubuntu-",
      ".ubuntu",
      "ubuntu.",
      "_ubuntu",
      "ubuntu/",
      "/ubuntu",
      "ubuntu//name",
      "ubuntu___name",
      "ubuntu name",
      "ubuntu:tag",
    ]) {
      expect(isValidRepositoryName(name), name).toBe(false);
    }
  });

  it("bounds the length so names stay pullable by clients that cap at 255", () => {
    expect(isValidRepositoryName("a".repeat(MAX_NAME_LENGTH))).toBe(true);
    expect(isValidRepositoryName("a".repeat(MAX_NAME_LENGTH + 1))).toBe(false);
  });
});

describe("isValidTag", () => {
  it("accepts the spec's tag alphabet", () => {
    for (const tag of ["latest", "v1.0.0", "_underscore", "A", "0", "test0", "sha256-abc", "a".repeat(128)]) {
      expect(isValidTag(tag), tag).toBe(true);
    }
  });

  it("rejects tags that start with a separator or exceed 128 characters", () => {
    // The conformance suite pulls `.INVALID_MANIFEST_NAME` and expects a 404,
    // which depends on this being an invalid *tag* rather than a bad digest.
    expect(isValidTag(".INVALID_MANIFEST_NAME")).toBe(false);
    expect(isValidTag("-leading-dash")).toBe(false);
    expect(isValidTag("")).toBe(false);
    expect(isValidTag("has:colon")).toBe(false);
    expect(isValidTag("has/slash")).toBe(false);
    expect(isValidTag("a".repeat(129))).toBe(false);
  });
});
