import { describe, expect, it } from "vitest";
import { type CleanupRule, type TagState, type TagsRule, evaluateCleanup } from "./evaluate.js";

const DAY = 86_400_000;
const NOW = Date.parse("2026-07-10T00:00:00Z");

function tag(name: string, daysOld = 0): TagState {
  return { name, updatedAt: NOW - daysOld * DAY };
}

/** A rule that governs every tag in every repository and keeps nothing. */
function rule(overrides: Partial<TagsRule> = {}): TagsRule {
  return { repositories: "*", tags: {}, keepLast: null, keepWithinDays: null, ...overrides };
}

const evaluate = (repository: string, tags: TagState[], rules: CleanupRule[]) =>
  evaluateCleanup({ repository, tags, rules, now: NOW })
    .map((entry) => entry.name)
    .sort();

describe("evaluateCleanup", () => {
  it("never touches a tag no rule governs", () => {
    const rules = [rule({ tags: { pattern: "nightly-*" } })];
    expect(evaluate("acme/api", [tag("v1.0.0"), tag("latest")], rules)).toEqual([]);
  });

  it("never touches a repository no rule names", () => {
    const rules = [rule({ repositories: "acme/other" })];
    expect(evaluate("acme/api", [tag("v1.0.0")], rules)).toEqual([]);
  });

  it("deletes everything a rule governs and keeps nothing of", () => {
    expect(evaluate("acme/api", [tag("a"), tag("b")], [rule()])).toEqual(["a", "b"]);
  });

  it("deletes nothing when there are no rules at all", () => {
    // An empty policy is not a policy that deletes everything.
    expect(evaluate("acme/api", [tag("a"), tag("b")], [])).toEqual([]);
  });

  it("keeps the newest n by update time", () => {
    const tags = [tag("old", 30), tag("mid", 10), tag("new", 1)];
    expect(evaluate("acme/api", tags, [rule({ keepLast: 2 })])).toEqual(["old"]);
  });

  it("keeps the newest n by version precedence when asked", () => {
    // Updated in the wrong order on purpose: 1.10.0 is the newest version but
    // the oldest write. A release rule must keep it.
    const tags = [tag("1.10.0", 30), tag("1.9.0", 10), tag("1.2.0", 1)];
    const rules = [rule({ tags: { semver: "*" }, keepLast: 2, keepBy: "semver" })];
    expect(evaluate("acme/api", tags, rules)).toEqual(["1.2.0"]);
  });

  it("keeps anything updated within the window", () => {
    const tags = [tag("old", 30), tag("recent", 3)];
    expect(evaluate("acme/api", tags, [rule({ keepWithinDays: 7 })])).toEqual(["old"]);
  });

  it("keeps a tag any rule keeps, even when another would delete it", () => {
    const tags = [tag("v1.0.0", 30), tag("nightly", 30)];
    const rules = [rule({ tags: { semver: "*" }, keepLast: 5 }), rule({ tags: { pattern: "nightly*" } })];
    expect(evaluate("acme/api", tags, rules)).toEqual(["nightly"]);
  });

  it("filters by semver range", () => {
    const tags = [tag("1.0.0"), tag("2.0.0"), tag("latest")];
    const rules = [rule({ tags: { semver: "^1.0.0" } })];
    expect(evaluate("acme/api", tags, rules)).toEqual(["1.0.0"]);
  });

  it("matches a repository glob", () => {
    const rules = [rule({ repositories: "acme/*" })];
    expect(evaluate("acme/api", [tag("a")], rules)).toEqual(["a"]);
    expect(evaluate("other/api", [tag("a")], rules)).toEqual([]);
  });

  it("combines keepLast and keepWithinDays as a union of what they keep", () => {
    const tags = [tag("a", 1), tag("b", 2), tag("c", 30), tag("d", 40)];
    // keepLast 1 saves `a`; keepWithinDays 3 saves `a` and `b`.
    const rules = [rule({ keepLast: 1, keepWithinDays: 3 })];
    expect(evaluate("acme/api", tags, rules)).toEqual(["c", "d"]);
  });

  it("keeps everything when keepLast exceeds the number of tags", () => {
    expect(evaluate("acme/api", [tag("a"), tag("b")], [rule({ keepLast: 10 })])).toEqual([]);
  });

  it("orders by version and then by update time, so a non-version never outranks a version", () => {
    // `latest` is not a version, so a semver-ordered rule cannot rank it, and
    // ranking it last would delete the newest release. It is simply not governed.
    const tags = [tag("latest", 1), tag("1.0.0", 20), tag("2.0.0", 30)];
    const rules = [rule({ tags: { semver: "*" }, keepLast: 1, keepBy: "semver" })];
    expect(evaluate("acme/api", tags, rules)).toEqual(["1.0.0"]);
  });

  it("reports why each tag is going", () => {
    const result = evaluateCleanup({
      repository: "acme/api",
      tags: [tag("old", 30)],
      rules: [rule({ keepLast: 0 })],
      now: NOW,
    });
    expect(result).toHaveLength(1);
    expect(result[0]?.reason).toContain("cleanup");
  });

  it("is stable: evaluating twice gives the same answer", () => {
    const tags = [tag("a", 1), tag("b", 2), tag("c", 3)];
    const rules = [rule({ keepLast: 1 })];
    expect(evaluate("acme/api", tags, rules)).toEqual(evaluate("acme/api", tags, rules));
  });

  it("treats a rule with no kind as a tags rule", () => {
    // Stored rows written before the untagged kind existed carry no `kind`, and
    // must keep meaning what they meant: a tags rule.
    const rules: CleanupRule[] = [{ repositories: "*", tags: {}, keepLast: 1, keepWithinDays: null }];
    expect(evaluate("acme/api", [tag("a", 1), tag("b", 2)], rules)).toEqual(["b"]);
  });

  it("ignores an untagged rule, which governs no tags", () => {
    const rules: CleanupRule[] = [{ kind: "untagged", repositories: "*", olderThanDays: 1 }];
    expect(evaluate("acme/api", [tag("a", 90), tag("b", 90)], rules)).toEqual([]);
  });
});

describe("evaluateCleanup: guards against deleting everything", () => {
  it("refuses a rule whose repository glob is empty", () => {
    const rules = [rule({ repositories: "" })];
    expect(evaluate("acme/api", [tag("a")], rules)).toEqual([]);
  });

  it("ignores a rule with an unparseable semver range rather than governing every tag", () => {
    // A typo in a range must not widen the rule to everything.
    const rules = [rule({ tags: { semver: "garbage" } })];
    expect(evaluate("acme/api", [tag("1.0.0"), tag("latest")], rules)).toEqual([]);
  });

  it("selects tags by regular expression", () => {
    const rules = [rule({ tags: { regex: "^nightly-\\d{8}$" } })];
    const tags = [tag("nightly-20260710"), tag("nightly-latest"), tag("v1.0.0")];
    expect(evaluate("acme/api", tags, rules)).toEqual(["nightly-20260710"]);
  });

  it("ignores a rule with an uncompilable regex rather than governing every tag", () => {
    const rules = [rule({ tags: { regex: "(unclosed" } })];
    expect(evaluate("acme/api", [tag("1.0.0"), tag("latest")], rules)).toEqual([]);
  });

  it("keeps by semver while governing by regex", () => {
    // "let the user choose how the cleanup runs": pick the tags with one
    // vocabulary, rank them with another.
    const rules = [rule({ tags: { regex: "^v" }, keepLast: 2, keepBy: "semver" })];
    const tags = [tag("v1.9.0"), tag("v1.10.0"), tag("v1.2.0"), tag("latest")];
    expect(evaluate("acme/api", tags, rules)).toEqual(["v1.2.0"]);
  });
});
