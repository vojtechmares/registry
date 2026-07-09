import { type Identifier, type Version, compareVersions, parseVersion } from "./version.js";

/**
 * Version ranges, in the grammar every JavaScript developer already knows:
 * `^1.2.3`, `~1.2`, `>=1.0.0 <2.0.0`, `1.2.x`, `1.2.3 - 2.3.4`, and unions of
 * those with `||`.
 *
 * A range compiles into a union of intersections of comparators. Carets,
 * tildes, wildcards and hyphens are all sugar that expands into a pair of
 * comparators before anything is compared.
 *
 * The behaviour matches `node-semver`, deliberately and to the letter,
 * including the corners around prereleases. Nobody writing `^1.2.3` in a
 * retention rule is going to read a specification first; they will assume it
 * means what it means in every `package.json` they have ever opened.
 */

export type Operator = "<" | "<=" | ">" | ">=" | "=";

export interface Comparator {
  readonly operator: Operator;
  readonly version: Version;
}

/** A union of comparator sets. A version satisfies the range if it satisfies any set. */
export type Range = readonly (readonly Comparator[])[];

export interface RangeOptions {
  /**
   * Widen every bound the range derived from a partial version down to its
   * earliest prerelease, and stop filtering prereleases out. A cleanup rule
   * that means to sweep `1.2.4-rc.1` has to say so.
   */
  readonly includePrerelease?: boolean;
}

const ANY: Range = [[]];

/** A partial version: `1`, `1.2`, `1.2.3`, with `x`, `X` or `*` standing for "any". */
const PARTIAL =
  /^v?(\d+|[xX*])(?:\.(\d+|[xX*])(?:\.(\d+|[xX*])(?:-([0-9a-zA-Z.-]+))?(?:\+[0-9a-zA-Z.-]+)?)?)?$/;

interface Partial {
  readonly major: number | null;
  readonly minor: number | null;
  readonly patch: number | null;
  readonly prerelease: string | null;
}

/** True when the partial left some field for the range to fill in. */
function isPartial(partial: Partial): boolean {
  return partial.minor === null || partial.patch === null;
}

function isWildcard(value: string | undefined): boolean {
  return value === "x" || value === "X" || value === "*";
}

function parsePartial(text: string): Partial | null {
  const match = PARTIAL.exec(text);
  if (match === null) return null;

  // A field cannot be pinned once an earlier one is a wildcard. `1.x.3` names
  // no set of versions, and guessing that it meant `1.x` would have a retention
  // rule quietly match something other than what was typed.
  if (isWildcard(match[1]) && match[2] !== undefined && !isWildcard(match[2])) return null;
  if (isWildcard(match[2]) && match[3] !== undefined && !isWildcard(match[3])) return null;

  const part = (value: string | undefined): number | null => {
    if (value === undefined || isWildcard(value)) return null;
    const parsed = Number(value);
    return Number.isSafeInteger(parsed) ? parsed : null;
  };

  const major = part(match[1]);
  const minor = major === null ? null : part(match[2]);

  return {
    major,
    minor,
    patch: minor === null ? null : part(match[3]),
    prerelease: match[4] ?? null,
  };
}

function version(
  major: number,
  minor: number,
  patch: number,
  prerelease: readonly Identifier[] = [],
): Version {
  return { major, minor, patch, prerelease, build: [], raw: "" };
}

function parsePrereleaseIdentifiers(text: string): Identifier[] {
  return text.split(".").map((part) => (/^(?:0|[1-9]\d*)$/.test(part) ? Number(part) : part));
}

/**
 * The exclusive upper bound of a range that names a partial version.
 *
 * `<2.0.0-0` rather than `<2.0.0`, so that `2.0.0-alpha` - which precedes
 * `2.0.0` - is excluded too. `^1.x` means "no version 2", and a release
 * candidate for version 2 is a version 2.
 */
function upperBound(major: number, minor: number, patch: number): Comparator {
  return { operator: "<", version: version(major, minor, patch, [0]) };
}

/**
 * The inclusive lower bound.
 *
 * `floor` drops it to the earliest possible prerelease. It is set when the
 * caller asked to include prereleases *and* the range left a field unspecified:
 * `^1.x` then reaches `1.0.0-alpha`, while `^1.2.3` still does not, because
 * `1.2.3-alpha` precedes the `1.2.3` that was asked for by name.
 */
function lowerBound(partial: Partial, floor: boolean): Comparator {
  const explicit = partial.prerelease !== null;
  const prerelease = explicit ? parsePrereleaseIdentifiers(partial.prerelease!) : floor ? [0] : [];

  return {
    operator: ">=",
    version: version(partial.major ?? 0, partial.minor ?? 0, partial.patch ?? 0, prerelease),
  };
}

/** `^1.2.3` - anything that does not change the leftmost non-zero digit. */
function caret(partial: Partial, includePrerelease: boolean): Comparator[] {
  if (partial.major === null) return [];
  const lower = lowerBound(partial, includePrerelease && isPartial(partial));

  if (partial.minor === null) return [lower, upperBound(partial.major + 1, 0, 0)];
  if (partial.major !== 0) return [lower, upperBound(partial.major + 1, 0, 0)];
  if (partial.minor !== 0) return [lower, upperBound(0, partial.minor + 1, 0)];
  if (partial.patch === null) return [lower, upperBound(0, 1, 0)];
  return [lower, upperBound(0, 0, partial.patch + 1)];
}

/** `~1.2.3` - patch changes if a minor is given, minor changes otherwise. */
function tilde(partial: Partial, includePrerelease: boolean): Comparator[] {
  if (partial.major === null) return [];
  const lower = lowerBound(partial, includePrerelease && isPartial(partial));

  if (partial.minor === null) return [lower, upperBound(partial.major + 1, 0, 0)];
  return [lower, upperBound(partial.major, partial.minor + 1, 0)];
}

/** A bare partial: `1.2.x` is every patch of `1.2`; `1.2.3` is itself. */
function exact(partial: Partial, includePrerelease: boolean): Comparator[] {
  if (partial.major === null) return [];
  const lower = lowerBound(partial, includePrerelease && isPartial(partial));

  if (partial.minor === null) return [lower, upperBound(partial.major + 1, 0, 0)];
  if (partial.patch === null) return [lower, upperBound(partial.major, partial.minor + 1, 0)];

  const parsed = parseVersion(rebuild(partial));
  return parsed === null ? [] : [{ operator: "=", version: parsed }];
}

function rebuild(partial: Partial): string {
  const core = `${partial.major ?? 0}.${partial.minor ?? 0}.${partial.patch ?? 0}`;
  return partial.prerelease === null ? core : `${core}-${partial.prerelease}`;
}

/**
 * `1.2.3 - 2.3` - inclusive at both ends, with a partial upper bound widened to
 * all of it, and a wildcard at either end meaning "unbounded in that direction".
 *
 * Unlike a caret, a hyphen's lower bound drops to its earliest prerelease even
 * when fully specified: a hyphen reads as an interval rather than as a minimum.
 */
function hyphen(from: Partial, to: Partial, includePrerelease: boolean): Comparator[] | null {
  const bounds: Comparator[] = [];

  if (from.major !== null) bounds.push(lowerBound(from, includePrerelease));

  if (to.major === null) return bounds;
  if (to.minor === null) return [...bounds, upperBound(to.major + 1, 0, 0)];
  if (to.patch === null) return [...bounds, upperBound(to.major, to.minor + 1, 0)];

  const parsed = parseVersion(rebuild(to));
  return parsed === null ? null : [...bounds, { operator: "<=", version: parsed }];
}

const COMPARATOR = /^(<=|>=|<|>|=)?\s*(.+)$/;

function parseComparatorSet(text: string, includePrerelease: boolean): Comparator[] | null {
  const trimmed = text.trim();
  if (trimmed === "" || trimmed === "*") return [];

  // A hyphen range is the only place a space is not an intersection.
  const parts = trimmed.split(/\s+/);
  if (parts.length === 3 && parts[1] === "-") {
    const from = parsePartial(parts[0]!);
    const to = parsePartial(parts[2]!);
    if (from === null || to === null) return null;
    return hyphen(from, to, includePrerelease);
  }

  const comparators: Comparator[] = [];
  for (const part of parts) {
    const expanded = parseComparator(part, includePrerelease);
    if (expanded === null) return null;
    comparators.push(...expanded);
  }
  return comparators;
}

function parseComparator(text: string, includePrerelease: boolean): Comparator[] | null {
  if (text === "*" || text === "x" || text === "X") return [];

  if (text.startsWith("^")) {
    const partial = parsePartial(text.slice(1));
    return partial === null ? null : caret(partial, includePrerelease);
  }
  if (text.startsWith("~")) {
    const partial = parsePartial(text.slice(1));
    return partial === null ? null : tilde(partial, includePrerelease);
  }

  const match = COMPARATOR.exec(text);
  if (match === null) return null;

  const operator = (match[1] ?? "=") as Operator;
  const partial = parsePartial(match[2]!);
  if (partial === null) return null;

  // An explicit comparator is taken at its word: `>=1.2.3` never reaches
  // `1.2.3-alpha`, whatever the prerelease option says.
  if (operator === "=") return exact(partial, includePrerelease);
  if (partial.major === null) return operator === ">=" || operator === "<=" ? [] : null;

  // `>=1.2` means `>=1.2.0`, and `<1.2` means `<1.2.0`: an inequality reads a
  // missing field as zero, where a bare partial reads it as a wildcard.
  const parsed = parseVersion(rebuild(partial));
  return parsed === null ? null : [{ operator, version: parsed }];
}

/**
 * `>= 1.2.3` is `>=1.2.3`. A space is an intersection everywhere except right
 * after an operator, so it is closed up before anything is split on whitespace.
 */
function normalize(text: string): string {
  return text.replace(/(<=|>=|<|>|=|\^|~)\s+/g, "$1");
}

export function parseRange(text: string, options: RangeOptions = {}): Range | null {
  const includePrerelease = options.includePrerelease === true;
  if (text.trim() === "") return ANY;

  const sets: Comparator[][] = [];
  for (const part of normalize(text).split("||")) {
    const set = parseComparatorSet(part, includePrerelease);
    if (set === null) return null;
    sets.push(set);
  }
  return sets;
}

function matchesComparator(candidate: Version, comparator: Comparator): boolean {
  const order = compareVersions(candidate, comparator.version);
  switch (comparator.operator) {
    case "<":
      return order < 0;
    case "<=":
      return order <= 0;
    case ">":
      return order > 0;
    case ">=":
      return order >= 0;
    case "=":
      return order === 0;
  }
}

function sameTuple(a: Version, b: Version): boolean {
  return a.major === b.major && a.minor === b.minor && a.patch === b.patch;
}

/**
 * Whether a prerelease may even be considered against this comparator set.
 *
 * A prerelease is admitted only where the set explicitly names a prerelease of
 * the same `major.minor.patch`. Without this, `^1.2.3` would match
 * `1.2.4-alpha` - which sorts inside the interval but is not a release, and is
 * not what anyone writing `^1.2.3` meant.
 */
function admitsPrerelease(candidate: Version, set: readonly Comparator[]): boolean {
  return set.some(
    (comparator) => comparator.version.prerelease.length > 0 && sameTuple(candidate, comparator.version),
  );
}

function matchesSet(candidate: Version, set: readonly Comparator[], includePrerelease: boolean): boolean {
  if (!set.every((comparator) => matchesComparator(candidate, comparator))) return false;
  if (candidate.prerelease.length === 0 || includePrerelease) return true;
  return admitsPrerelease(candidate, set);
}

export function satisfies(tag: string, range: string, options: RangeOptions = {}): boolean {
  const candidate = parseVersion(tag);
  if (candidate === null) return false;

  const parsed = parseRange(range, options);
  if (parsed === null) return false;

  return parsed.some((set) => matchesSet(candidate, set, options.includePrerelease === true));
}
