import { describe, expect, it } from "vitest";
import { latestVersions, matchesTagFilter, sortByPrecedence } from "./filter.js";

describe("matchesTagFilter", () => {
  it("matches everything when no filter is set", () => {
    expect(matchesTagFilter("latest", {})).toBe(true);
    expect(matchesTagFilter("anything", {})).toBe(true);
  });

  it("matches a glob pattern", () => {
    expect(matchesTagFilter("release-1.2", { pattern: "release-*" })).toBe(true);
    expect(matchesTagFilter("nightly", { pattern: "release-*" })).toBe(false);
    expect(matchesTagFilter("v1", { pattern: "v?" })).toBe(true);
    expect(matchesTagFilter("v12", { pattern: "v?" })).toBe(false);
  });

  it("treats a pattern's regular-expression metacharacters as literals", () => {
    // A pattern is a glob, not a regular expression. `.` matches a dot.
    expect(matchesTagFilter("v1x2", { pattern: "v1.2" })).toBe(false);
    expect(matchesTagFilter("v1.2", { pattern: "v1.2" })).toBe(true);
    expect(matchesTagFilter("aaa", { pattern: "a+" })).toBe(false);
    expect(matchesTagFilter("a+", { pattern: "a+" })).toBe(true);
  });

  it("anchors the pattern at both ends", () => {
    expect(matchesTagFilter("prerelease-1", { pattern: "release-*" })).toBe(false);
  });

  it("matches a semver range", () => {
    expect(matchesTagFilter("v1.5.0", { semver: "^1.2.3" })).toBe(true);
    expect(matchesTagFilter("v2.0.0", { semver: "^1.2.3" })).toBe(false);
  });

  it("rejects a tag that is not a version when a semver range is set", () => {
    expect(matchesTagFilter("latest", { semver: "*" })).toBe(false);
  });

  it("requires both a pattern and a range when both are set", () => {
    const filter = { pattern: "v*", semver: "^1.0.0" };
    expect(matchesTagFilter("v1.2.0", filter)).toBe(true);
    // Matches the range but not the pattern.
    expect(matchesTagFilter("1.2.0", filter)).toBe(false);
    // Matches the pattern but not the range.
    expect(matchesTagFilter("v2.0.0", filter)).toBe(false);
  });

  it("passes the prerelease option through to the range", () => {
    expect(matchesTagFilter("1.2.4-rc.1", { semver: "^1.2.3" })).toBe(false);
    expect(matchesTagFilter("1.2.4-rc.1", { semver: "^1.2.3", includePrerelease: true })).toBe(true);
  });

  it("never matches when the range will not parse", () => {
    expect(matchesTagFilter("1.2.3", { semver: "garbage" })).toBe(false);
  });

  it("matches a regular expression", () => {
    expect(matchesTagFilter("v1.2.3", { regex: "^v\\d+\\.\\d+\\.\\d+$" })).toBe(true);
    expect(matchesTagFilter("v1.2.3-rc1", { regex: "^v\\d+\\.\\d+\\.\\d+$" })).toBe(false);
  });

  it("searches with a regular expression, so ^ and $ mean what they say", () => {
    // Unlike `pattern`, which is an anchored glob. This is what a reader of a
    // regular expression expects, and the dashboard says so next to the field.
    expect(matchesTagFilter("v1-rc1", { regex: "rc" })).toBe(true);
    expect(matchesTagFilter("v1-rc1", { regex: "^rc" })).toBe(false);
  });

  it("treats an empty regular expression as unset", () => {
    expect(matchesTagFilter("anything", { regex: "" })).toBe(true);
  });

  it("never matches when the regular expression will not compile", () => {
    // The same direction as an unparseable range: a broken filter governs
    // nothing, so a typo in a cleanup rule deletes nothing.
    expect(matchesTagFilter("anything", { regex: "(unclosed" })).toBe(false);
    expect(matchesTagFilter("anything", { regex: "a**" })).toBe(false);
  });

  it("requires the pattern, the range and the regex when all three are set", () => {
    const filter = { pattern: "v*", semver: "^1.0.0", regex: "\\.0$" };
    expect(matchesTagFilter("v1.2.0", filter)).toBe(true);
    // Fails the regex alone.
    expect(matchesTagFilter("v1.2.1", filter)).toBe(false);
    // Fails the pattern alone.
    expect(matchesTagFilter("1.2.0", filter)).toBe(false);
    // Fails the range alone.
    expect(matchesTagFilter("v2.0.0", filter)).toBe(false);
  });

  it("does not backtrack on a regular expression that would defeat one that did", () => {
    const started = performance.now();
    expect(matchesTagFilter("a".repeat(60), { regex: "^(a+)+b$" })).toBe(false);
    expect(performance.now() - started).toBeLessThan(100);
  });
});

describe("sortByPrecedence", () => {
  it("orders versions oldest first and drops what is not a version", () => {
    const sorted = sortByPrecedence(["v2.0.0", "latest", "1.0.0", "1.0.0-rc.1", "1.10.0", "1.2.0"]);
    expect(sorted).toEqual(["1.0.0-rc.1", "1.0.0", "1.2.0", "1.10.0", "v2.0.0"]);
  });

  it("does not mutate its input", () => {
    const tags = ["2.0.0", "1.0.0"];
    sortByPrecedence(tags);
    expect(tags).toEqual(["2.0.0", "1.0.0"]);
  });
});

describe("latestVersions", () => {
  it("keeps the highest n by precedence, not by string order", () => {
    // "1.10.0" < "1.9.0" as strings, and the other way round as versions.
    expect(latestVersions(["1.9.0", "1.10.0", "1.2.0"], 2)).toEqual(["1.10.0", "1.9.0"]);
  });

  it("ignores tags that are not versions", () => {
    expect(latestVersions(["latest", "1.0.0", "main"], 2)).toEqual(["1.0.0"]);
  });

  it("returns everything when it holds fewer than n", () => {
    expect(latestVersions(["1.0.0"], 5)).toEqual(["1.0.0"]);
  });

  it("returns nothing for a non-positive count", () => {
    expect(latestVersions(["1.0.0"], 0)).toEqual([]);
  });
});
