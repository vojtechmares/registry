import { describe, expect, it } from "vitest";
import { parseRange, satisfies } from "./range.js";

describe("parseRange", () => {
  it("rejects nonsense rather than matching everything", () => {
    expect(parseRange("not a range")).toBeNull();
    expect(parseRange(">=")).toBeNull();
    expect(parseRange("^")).toBeNull();
    expect(parseRange("<>1.2.3")).toBeNull();
    expect(parseRange("- 1.2.3")).toBeNull();
  });

  it("accepts the empty range and the star, both meaning any version", () => {
    expect(parseRange("")).not.toBeNull();
    expect(parseRange("*")).not.toBeNull();
  });

  it("closes up a space between an operator and its version", () => {
    expect(parseRange(">= 1.2.3")).not.toBeNull();
    expect(satisfies("1.2.4", ">= 1.2.3")).toBe(true);
    expect(satisfies("1.5.0", ">= 1.0.0 < 2.0.0")).toBe(true);
    expect(satisfies("2.0.0", ">= 1.0.0 < 2.0.0")).toBe(false);
  });

  it("refuses a field pinned after a wildcard, which names no set of versions", () => {
    // Guessing that `1.x.3` meant `1.x` would have a retention rule quietly
    // match something other than what was typed.
    expect(parseRange("1.x.3")).toBeNull();
    expect(parseRange("^1.x.3")).toBeNull();
    expect(parseRange("x.1")).toBeNull();
    // Two wildcards in a row are merely redundant, not contradictory.
    expect(parseRange("x.x")).not.toBeNull();
  });
});

describe("satisfies: exact and comparators", () => {
  it("matches an exact version", () => {
    expect(satisfies("1.2.3", "1.2.3")).toBe(true);
    expect(satisfies("1.2.4", "1.2.3")).toBe(false);
    expect(satisfies("1.2.3", "=1.2.3")).toBe(true);
  });

  it("matches greater and less than", () => {
    expect(satisfies("1.2.4", ">1.2.3")).toBe(true);
    expect(satisfies("1.2.3", ">1.2.3")).toBe(false);
    expect(satisfies("1.2.3", ">=1.2.3")).toBe(true);
    expect(satisfies("1.2.2", "<1.2.3")).toBe(true);
    expect(satisfies("1.2.3", "<=1.2.3")).toBe(true);
  });

  it("intersects comparators separated by a space", () => {
    expect(satisfies("1.5.0", ">=1.0.0 <2.0.0")).toBe(true);
    expect(satisfies("2.0.0", ">=1.0.0 <2.0.0")).toBe(false);
    expect(satisfies("0.9.0", ">=1.0.0 <2.0.0")).toBe(false);
  });

  it("unions comparator sets separated by ||", () => {
    expect(satisfies("1.5.0", "^1.0.0 || ^3.0.0")).toBe(true);
    expect(satisfies("3.1.0", "^1.0.0 || ^3.0.0")).toBe(true);
    expect(satisfies("2.0.0", "^1.0.0 || ^3.0.0")).toBe(false);
  });

  it("tolerates a `v` prefix on either side", () => {
    expect(satisfies("v1.2.3", ">=v1.0.0")).toBe(true);
  });
});

describe("satisfies: caret", () => {
  it("allows changes that do not modify the leftmost non-zero digit", () => {
    expect(satisfies("1.2.3", "^1.2.3")).toBe(true);
    expect(satisfies("1.9.9", "^1.2.3")).toBe(true);
    expect(satisfies("2.0.0", "^1.2.3")).toBe(false);
    expect(satisfies("1.2.2", "^1.2.3")).toBe(false);
  });

  it("pins the minor for a 0.x version, where the minor carries the breaking change", () => {
    expect(satisfies("0.2.9", "^0.2.3")).toBe(true);
    expect(satisfies("0.3.0", "^0.2.3")).toBe(false);
  });

  it("pins the patch for a 0.0.x version", () => {
    expect(satisfies("0.0.3", "^0.0.3")).toBe(true);
    expect(satisfies("0.0.4", "^0.0.3")).toBe(false);
  });

  it("accepts a partial version", () => {
    expect(satisfies("1.9.0", "^1.2")).toBe(true);
    expect(satisfies("2.0.0", "^1.2")).toBe(false);
    expect(satisfies("0.9.0", "^0")).toBe(true);
    expect(satisfies("1.0.0", "^0")).toBe(false);
  });
});

describe("satisfies: tilde", () => {
  it("allows patch changes when the minor is given", () => {
    expect(satisfies("1.2.9", "~1.2.3")).toBe(true);
    expect(satisfies("1.3.0", "~1.2.3")).toBe(false);
  });

  it("allows minor changes when only the major is given", () => {
    expect(satisfies("1.9.0", "~1")).toBe(true);
    expect(satisfies("2.0.0", "~1")).toBe(false);
  });
});

describe("satisfies: wildcards", () => {
  it("treats x, X and * as a wildcard in any position", () => {
    expect(satisfies("1.2.9", "1.2.x")).toBe(true);
    expect(satisfies("1.3.0", "1.2.x")).toBe(false);
    expect(satisfies("1.9.9", "1.X")).toBe(true);
    expect(satisfies("2.0.0", "1.*")).toBe(false);
  });

  it("matches anything against a bare star", () => {
    expect(satisfies("0.0.1", "*")).toBe(true);
    expect(satisfies("99.0.0", "")).toBe(true);
  });
});

describe("satisfies: hyphen ranges", () => {
  it("is inclusive at both ends", () => {
    expect(satisfies("1.2.3", "1.2.3 - 2.3.4")).toBe(true);
    expect(satisfies("2.3.4", "1.2.3 - 2.3.4")).toBe(true);
    expect(satisfies("2.3.5", "1.2.3 - 2.3.4")).toBe(false);
  });

  it("widens a partial upper bound to the whole of it", () => {
    expect(satisfies("2.3.9", "1.2.3 - 2.3")).toBe(true);
    expect(satisfies("2.4.0", "1.2.3 - 2.3")).toBe(false);
    expect(satisfies("2.9.9", "1.2.3 - 2")).toBe(true);
    expect(satisfies("3.0.0", "1.2.3 - 2")).toBe(false);
  });

  it("reads a wildcard at either end as unbounded in that direction", () => {
    expect(satisfies("0.0.1", "x - 2")).toBe(true);
    expect(satisfies("3.0.0", "x - 2")).toBe(false);
    expect(satisfies("99.0.0", "1.0.0 - x")).toBe(true);
    expect(satisfies("0.9.0", "1.0.0 - x")).toBe(false);
  });
});

describe("satisfies: prereleases", () => {
  it("excludes a prerelease from a range that names none", () => {
    // `1.2.4-alpha` is not a release, and a rule written for releases must not
    // sweep it up merely because it sorts inside the interval.
    expect(satisfies("1.2.4-alpha", "^1.2.3")).toBe(false);
    expect(satisfies("2.0.0-alpha", "^1.2.3")).toBe(false);
    expect(satisfies("1.5.0-beta", ">=1.0.0 <2.0.0")).toBe(false);
  });

  it("admits a prerelease of the very version a comparator names", () => {
    expect(satisfies("1.2.3-beta", ">=1.2.3-alpha")).toBe(true);
    expect(satisfies("1.2.3-alpha", ">=1.2.3-alpha")).toBe(true);
    expect(satisfies("1.2.3-alpha.1", ">=1.2.3-alpha")).toBe(true);
  });

  it("still excludes a prerelease of a different version in the same range", () => {
    expect(satisfies("1.2.4-beta", ">=1.2.3-alpha <2.0.0")).toBe(false);
  });

  it("admits every prerelease when asked to", () => {
    expect(satisfies("1.2.4-alpha", "^1.2.3", { includePrerelease: true })).toBe(true);
    expect(satisfies("2.0.0-alpha", "^1.2.3", { includePrerelease: true })).toBe(false);
  });

  it("does not let a caret range reach a prerelease of its upper bound", () => {
    expect(satisfies("2.0.0-alpha", "^1.2.3", { includePrerelease: true })).toBe(false);
  });
});

describe("satisfies: non-versions", () => {
  it("never matches a tag that is not a version", () => {
    expect(satisfies("latest", "*")).toBe(false);
    expect(satisfies("main", ">=0.0.0")).toBe(false);
  });

  it("never matches against a range that will not parse", () => {
    expect(satisfies("1.2.3", "garbage")).toBe(false);
  });
});
