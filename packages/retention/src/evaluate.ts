import { isValidRegex } from "@registry/regex";
import {
  type TagFilter,
  compareVersions,
  matchesTagFilter,
  parseRange,
  parseVersion,
} from "@registry/semver";

/**
 * What a cleanup run deletes.
 *
 * The model is deliberately the safe way round. A rule *governs* a set of tags,
 * and says how many of them to keep; a tag no rule governs is never touched.
 * The alternative - "everything not explicitly retained is deleted" - is what
 * Harbor does, and it means a policy with a typo in its filter empties the
 * repository. Here a typo deletes nothing.
 */

export interface TagState {
  readonly name: string;
  readonly updatedAt: number;
}

export interface CleanupRule {
  /** A glob over repository names within the project. `*` for all of them. */
  readonly repositories: string;
  /** Which of that repository's tags this rule governs. An empty filter governs all. */
  readonly tags: TagFilter;
  /** Keep the newest this many. Null keeps none on this ground. */
  readonly keepLast: number | null;
  /** Keep anything updated within this many days. Null keeps none on this ground. */
  readonly keepWithinDays: number | null;
  /** How "newest" is decided. Defaults to update time. */
  readonly keepBy?: "updated" | "semver";
}

export interface Doomed {
  readonly name: string;
  readonly reason: string;
}

export interface CleanupInput {
  readonly repository: string;
  readonly tags: readonly TagState[];
  readonly rules: readonly CleanupRule[];
  readonly now: number;
}

const DAY = 86_400_000;

/** Anchored glob, with regular-expression metacharacters taken literally. */
function globMatches(pattern: string, value: string): boolean {
  if (pattern === "") return false;
  const escaped = pattern.replace(/[.*+?^${}()|[\]\\]/g, (char) =>
    char === "*" ? "[\\s\\S]*" : `\\${char}`,
  );
  return new RegExp(`^${escaped}$`).test(value);
}

/**
 * A rule with a filter that will not parse governs nothing.
 *
 * The alternative is that a typo in `^1.2.3` widens the rule to every tag in
 * the repository, and the next scheduled run deletes them.
 */
function ruleIsSound(rule: CleanupRule): boolean {
  if (rule.repositories === "") return false;

  const range = rule.tags.semver;
  if (range !== undefined && range !== "" && parseRange(range) === null) return false;

  const regex = rule.tags.regex;
  return regex === undefined || regex === "" || isValidRegex(regex);
}

/** Newest first, by whichever order the rule asked for. */
function rank(tags: readonly TagState[], keepBy: "updated" | "semver"): TagState[] {
  if (keepBy === "updated") {
    return [...tags].toSorted((a, b) => b.updatedAt - a.updatedAt || a.name.localeCompare(b.name));
  }

  return [...tags].toSorted((a, b) => {
    const left = parseVersion(a.name);
    const right = parseVersion(b.name);
    // A tag that is not a version cannot be ranked against one. It sorts last,
    // which is where a rule keeping the newest releases wants it.
    if (left === null && right === null) return b.updatedAt - a.updatedAt;
    if (left === null) return 1;
    if (right === null) return -1;
    return compareVersions(right, left) || b.updatedAt - a.updatedAt;
  });
}

/** The tags one rule keeps, out of the tags it governs. */
function kept(rule: CleanupRule, governed: readonly TagState[], now: number): Set<string> {
  const keep = new Set<string>();

  if (rule.keepLast !== null && rule.keepLast > 0) {
    for (const tag of rank(governed, rule.keepBy ?? "updated").slice(0, rule.keepLast)) {
      keep.add(tag.name);
    }
  }

  if (rule.keepWithinDays !== null && rule.keepWithinDays > 0) {
    const cutoff = now - rule.keepWithinDays * DAY;
    for (const tag of governed) if (tag.updatedAt >= cutoff) keep.add(tag.name);
  }

  return keep;
}

/**
 * The tags this run deletes from `repository`.
 *
 * A tag is deleted when some rule governs it and *no* rule keeps it. Keeping
 * wins over governing across rules, so a rule that protects `nightly` protects
 * it from the rule that would sweep everything.
 */
export function evaluateCleanup(input: CleanupInput): Doomed[] {
  const governed = new Set<string>();
  const keep = new Set<string>();

  for (const rule of input.rules) {
    if (!ruleIsSound(rule)) continue;
    if (!globMatches(rule.repositories, input.repository)) continue;

    const selected = input.tags.filter((tag) => matchesTagFilter(tag.name, rule.tags));
    if (selected.length === 0) continue;

    for (const tag of selected) governed.add(tag.name);
    for (const name of kept(rule, selected, input.now)) keep.add(name);
  }

  return input.tags
    .filter((tag) => governed.has(tag.name) && !keep.has(tag.name))
    .map((tag) => ({
      name: tag.name,
      reason: `cleanup: no rule retained "${tag.name}" in ${input.repository}`,
    }));
}
