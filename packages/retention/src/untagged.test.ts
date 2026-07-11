import { describe, expect, it } from "vitest";
import { type CleanupRule, type ManifestState, effectiveUntaggedTtl, evaluateUntagged } from "./evaluate.js";

const DAY = 86_400_000;
const NOW = Date.parse("2026-07-10T00:00:00Z");

function manifest(digest: string, daysOld = 0, isProtected = false): ManifestState {
  return { digest, pushedAt: NOW - daysOld * DAY, protected: isProtected };
}

/** An untagged rule that governs every repository and retires anything older than 30 days. */
function untagged(overrides: Partial<{ repositories: string; olderThanDays: number }> = {}): CleanupRule {
  return { kind: "untagged", repositories: "*", olderThanDays: 30, ...overrides };
}

/** A tags rule, which must never govern an untagged manifest. */
function tags(overrides: Partial<{ repositories: string }> = {}): CleanupRule {
  return { repositories: "*", tags: {}, keepLast: null, keepWithinDays: null, ...overrides };
}

const evaluate = (repository: string, manifests: ManifestState[], rules: CleanupRule[]) =>
  evaluateUntagged({ repository, manifests, rules, now: NOW })
    .map((entry) => entry.name)
    .sort();

describe("evaluateUntagged", () => {
  it("retires an untagged manifest older than the rule's TTL", () => {
    expect(evaluate("acme/api", [manifest("a", 40)], [untagged({ olderThanDays: 30 })])).toEqual(["a"]);
  });

  it("keeps an untagged manifest younger than the rule's TTL", () => {
    expect(evaluate("acme/api", [manifest("a", 10)], [untagged({ olderThanDays: 30 })])).toEqual([]);
  });

  it("never touches a repository no untagged rule matches", () => {
    const rules = [untagged({ repositories: "acme/other" })];
    expect(evaluate("acme/api", [manifest("a", 90)], rules)).toEqual([]);
  });

  it("matches a repository glob", () => {
    const rules = [untagged({ repositories: "acme/*" })];
    expect(evaluate("acme/api", [manifest("a", 90)], rules)).toEqual(["a"]);
    expect(evaluate("other/api", [manifest("a", 90)], rules)).toEqual([]);
  });

  it("spares a protected manifest whatever its age", () => {
    // A signature, an SBOM, or a platform manifest inside a live index.
    expect(evaluate("acme/api", [manifest("sig", 90, true)], [untagged({ olderThanDays: 1 })])).toEqual([]);
  });

  it("applies the minimum TTL when rules overlap", () => {
    const rules = [untagged({ olderThanDays: 30 }), untagged({ olderThanDays: 7 })];
    // Older than the strictest (7) is retired; younger than it survives.
    expect(evaluate("acme/api", [manifest("old", 10), manifest("new", 5)], rules)).toEqual(["old"]);
  });

  it("is not governed by a tags rule", () => {
    // Only untagged rules retire untagged manifests; a tags rule governs tags.
    expect(evaluate("acme/api", [manifest("a", 90)], [tags()])).toEqual([]);
  });

  it("retires nothing when there are no rules at all", () => {
    expect(evaluate("acme/api", [manifest("a", 900)], [])).toEqual([]);
  });

  it("ignores an untagged rule whose repository glob is empty", () => {
    expect(evaluate("acme/api", [manifest("a", 90)], [untagged({ repositories: "" })])).toEqual([]);
  });

  it("reports why each manifest is going", () => {
    const doomed = evaluateUntagged({
      repository: "acme/api",
      manifests: [manifest("a", 40)],
      rules: [untagged({ olderThanDays: 30 })],
      now: NOW,
    });
    expect(doomed).toHaveLength(1);
    expect(doomed[0]?.reason).toContain("untagged");
  });
});

describe("effectiveUntaggedTtl", () => {
  it("is null when no untagged rule governs the repository", () => {
    expect(effectiveUntaggedTtl("acme/api", [tags(), untagged({ repositories: "acme/other" })])).toBeNull();
  });

  it("is the minimum TTL across the untagged rules that match", () => {
    const rules = [untagged({ olderThanDays: 30 }), untagged({ olderThanDays: 7 }), tags()];
    expect(effectiveUntaggedTtl("acme/api", rules)).toBe(7);
  });
});
