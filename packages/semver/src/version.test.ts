import { describe, expect, it } from "vitest";
import { compareVersions, parseVersion } from "./version.js";

describe("parseVersion", () => {
  it("parses a plain release", () => {
    expect(parseVersion("1.2.3")).toMatchObject({ major: 1, minor: 2, patch: 3, prerelease: [], build: [] });
  });

  it("accepts the `v` prefix that image tags conventionally carry", () => {
    expect(parseVersion("v1.2.3")).toMatchObject({ major: 1, minor: 2, patch: 3 });
  });

  it("parses a prerelease into dot-separated identifiers", () => {
    expect(parseVersion("1.0.0-alpha.1")?.prerelease).toEqual(["alpha", 1]);
    expect(parseVersion("1.0.0-0.3.7")?.prerelease).toEqual([0, 3, 7]);
    expect(parseVersion("1.0.0-x.7.z.92")?.prerelease).toEqual(["x", 7, "z", 92]);
  });

  it("parses build metadata and keeps it out of the prerelease", () => {
    const version = parseVersion("1.0.0-beta+exp.sha.5114f85");
    expect(version?.prerelease).toEqual(["beta"]);
    expect(version?.build).toEqual(["exp", "sha", "5114f85"]);
  });

  it("rejects a prerelease identifier with a leading zero", () => {
    // `01` is neither a numeric identifier (those admit no leading zero) nor an
    // alphanumeric one (those need a non-digit). The grammar has no room for it.
    expect(parseVersion("1.0.0-01")).toBeNull();
    expect(parseVersion("1.0.0-0")?.prerelease).toEqual([0]);
  });

  it("keeps an identifier that merely starts with a digit as a string", () => {
    expect(parseVersion("1.0.0-0a")?.prerelease).toEqual(["0a"]);
    expect(parseVersion("1.0.0-2024-01-15")?.prerelease).toEqual(["2024-01-15"]);
  });

  it("rejects what is not a version", () => {
    for (const tag of ["latest", "", "1", "1.2", "1.2.3.4", "1.2.x", "-1.2.3", "1.2.3-", "1.2.3+"]) {
      expect(parseVersion(tag)).toBeNull();
    }
  });

  it("rejects leading zeroes in the version core, as the spec requires", () => {
    expect(parseVersion("01.2.3")).toBeNull();
    expect(parseVersion("1.02.3")).toBeNull();
    expect(parseVersion("1.2.03")).toBeNull();
  });

  it("rejects a version too large to compare exactly", () => {
    expect(parseVersion("99999999999999999999.0.0")).toBeNull();
  });
});

const order = (a: string, b: string) => compareVersions(parseVersion(a)!, parseVersion(b)!);

describe("compareVersions", () => {
  it("orders by major, then minor, then patch", () => {
    expect(order("1.0.0", "2.0.0")).toBe(-1);
    expect(order("2.0.0", "2.1.0")).toBe(-1);
    expect(order("2.1.0", "2.1.1")).toBe(-1);
    expect(order("2.1.1", "2.1.1")).toBe(0);
    expect(order("2.1.1", "2.1.0")).toBe(1);
  });

  it("puts a prerelease before its release", () => {
    expect(order("1.0.0-alpha", "1.0.0")).toBe(-1);
    expect(order("1.0.0", "1.0.0-alpha")).toBe(1);
  });

  it("follows the precedence example from the specification", () => {
    const ascending = [
      "1.0.0-alpha",
      "1.0.0-alpha.1",
      "1.0.0-alpha.beta",
      "1.0.0-beta",
      "1.0.0-beta.2",
      "1.0.0-beta.11",
      "1.0.0-rc.1",
      "1.0.0",
    ];
    for (let i = 0; i < ascending.length - 1; i++) {
      expect(order(ascending[i]!, ascending[i + 1]!)).toBe(-1);
    }
  });

  it("orders numeric identifiers numerically and others lexically", () => {
    // 11 > 2 numerically, though "11" < "2" as strings.
    expect(order("1.0.0-beta.2", "1.0.0-beta.11")).toBe(-1);
    expect(order("1.0.0-alpha.beta", "1.0.0-alpha.gamma")).toBe(-1);
  });

  it("ranks a numeric identifier below an alphanumeric one", () => {
    expect(order("1.0.0-1", "1.0.0-alpha")).toBe(-1);
  });

  it("ranks a longer prerelease above its prefix", () => {
    expect(order("1.0.0-alpha", "1.0.0-alpha.1")).toBe(-1);
  });

  it("ignores build metadata entirely", () => {
    expect(order("1.0.0+build.1", "1.0.0+build.2")).toBe(0);
    expect(order("1.0.0+build", "1.0.0")).toBe(0);
  });
});
