import { satisfies } from "./range.js";
import { compareVersions, parseVersion } from "./version.js";

/**
 * Which tags a rule applies to.
 *
 * A replication rule and a cleanup rule ask the same question of a tag, and
 * getting a different answer from each would be how a tag gets replicated and
 * then immediately deleted. Both ask it here.
 */
export interface TagFilter {
  /** A glob: `*` for any run of characters, `?` for one. Anchored at both ends. */
  readonly pattern?: string | undefined;
  /** A semver range: `^1.2.3`, `>=1.0.0 <2.0.0`, `1.x`. */
  readonly semver?: string | undefined;
  readonly includePrerelease?: boolean | undefined;
}

/**
 * Compiles a glob into an anchored regular expression.
 *
 * Every metacharacter but `*` and `?` is escaped, so a pattern of `v1.2` matches
 * the tag `v1.2` and not `v1x2`. A pattern is a glob because that is what an
 * operator expects when a field is called "pattern"; letting a regular
 * expression through would also let a catastrophic one through.
 */
function globToRegExp(pattern: string): RegExp {
  const escaped = pattern.replace(/[.*+?^${}()|[\]\\]/g, (char) =>
    char === "*" ? "[\\s\\S]*" : char === "?" ? "[\\s\\S]" : `\\${char}`,
  );
  return new RegExp(`^${escaped}$`);
}

export function matchesTagFilter(tag: string, filter: TagFilter): boolean {
  if (filter.pattern !== undefined && filter.pattern !== "" && !globToRegExp(filter.pattern).test(tag)) {
    return false;
  }

  if (filter.semver !== undefined && filter.semver !== "") {
    const options =
      filter.includePrerelease === undefined ? {} : { includePrerelease: filter.includePrerelease };
    if (!satisfies(tag, filter.semver, options)) return false;
  }

  return true;
}

/** The tags that are versions, oldest first. Anything that is not a version is dropped. */
export function sortByPrecedence(tags: readonly string[]): string[] {
  return tags
    .flatMap((tag) => {
      const version = parseVersion(tag);
      return version === null ? [] : [{ tag, version }];
    })
    .toSorted((a, b) => compareVersions(a.version, b.version))
    .map((entry) => entry.tag);
}

/**
 * The `count` highest versions, newest first.
 *
 * By precedence and never by string order: `1.10.0` follows `1.9.0`, and a
 * retention rule that sorted these as strings would keep the wrong one.
 */
export function latestVersions(tags: readonly string[], count: number): string[] {
  if (count <= 0) return [];
  const sorted = sortByPrecedence(tags);
  return sorted.slice(Math.max(0, sorted.length - count)).toReversed();
}
