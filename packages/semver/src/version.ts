/**
 * Semantic Versioning 2.0.0, as far as an image tag needs it.
 *
 * Written out rather than pulled in, because the whole of it is a regular
 * expression and a comparison, and because the one place it is easy to get
 * wrong - that `1.0.0-beta.11` follows `1.0.0-beta.2`, and that both precede
 * `1.0.0` - is the place a retention rule silently deletes the wrong tag.
 *
 * The `v` prefix is accepted. It is not part of the specification, but a tag
 * that reads `v1.2.3` means what `1.2.3` means to everyone who typed it.
 */

const PATTERN =
  /^v?(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-((?:0|[1-9]\d*|\d*[a-zA-Z-][0-9a-zA-Z-]*)(?:\.(?:0|[1-9]\d*|\d*[a-zA-Z-][0-9a-zA-Z-]*))*))?(?:\+([0-9a-zA-Z-]+(?:\.[0-9a-zA-Z-]+)*))?$/;

/** A prerelease identifier is numeric, and compares as a number, or it is not. */
export type Identifier = string | number;

export interface Version {
  readonly major: number;
  readonly minor: number;
  readonly patch: number;
  readonly prerelease: readonly Identifier[];
  readonly build: readonly string[];
  /** The tag exactly as it was written, `v` and build metadata included. */
  readonly raw: string;
}

const NUMERIC = /^(?:0|[1-9]\d*)$/;

function identifier(part: string): Identifier {
  // `01` has a leading zero, so it is not a numeric identifier and must not
  // compare as the number one.
  return NUMERIC.test(part) ? Number(part) : part;
}

export function parseVersion(tag: string): Version | null {
  const match = PATTERN.exec(tag);
  if (match === null) return null;

  const [major, minor, patch] = [Number(match[1]), Number(match[2]), Number(match[3])];
  // A version past 2^53 would compare wrong the moment it was incremented.
  if (!Number.isSafeInteger(major) || !Number.isSafeInteger(minor) || !Number.isSafeInteger(patch)) {
    return null;
  }

  return {
    major,
    minor,
    patch,
    prerelease: match[4] === undefined ? [] : match[4].split(".").map(identifier),
    build: match[5] === undefined ? [] : match[5].split("."),
    raw: tag,
  };
}

export function isVersion(tag: string): boolean {
  return parseVersion(tag) !== null;
}

function compareNumbers(a: number, b: number): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

/**
 * Precedence between two prerelease identifiers.
 *
 * Numeric identifiers compare numerically, so `11` follows `2`. Alphanumeric
 * ones compare in ASCII order. A numeric identifier always has lower precedence
 * than an alphanumeric one, which is the rule that puts `1.0.0-1` before
 * `1.0.0-alpha`.
 */
function compareIdentifiers(a: Identifier, b: Identifier): number {
  const aNumeric = typeof a === "number";
  const bNumeric = typeof b === "number";

  if (aNumeric && bNumeric) return compareNumbers(a, b);
  if (aNumeric) return -1;
  if (bNumeric) return 1;
  return a < b ? -1 : a > b ? 1 : 0;
}

function comparePrerelease(a: readonly Identifier[], b: readonly Identifier[]): number {
  // A version with a prerelease has lower precedence than one without.
  if (a.length === 0 && b.length === 0) return 0;
  if (a.length === 0) return 1;
  if (b.length === 0) return -1;

  for (let i = 0; i < Math.min(a.length, b.length); i++) {
    const result = compareIdentifiers(a[i]!, b[i]!);
    if (result !== 0) return result;
  }

  // Everything so far is equal, so the version with more identifiers wins:
  // `1.0.0-alpha` precedes `1.0.0-alpha.1`.
  return compareNumbers(a.length, b.length);
}

/** -1, 0 or 1. Build metadata is ignored, exactly as the specification says. */
export function compareVersions(a: Version, b: Version): number {
  return (
    compareNumbers(a.major, b.major) ||
    compareNumbers(a.minor, b.minor) ||
    compareNumbers(a.patch, b.patch) ||
    comparePrerelease(a.prerelease, b.prerelease)
  );
}

/** True when the version carries a prerelease, and so is not a stable release. */
export function isPrerelease(version: Version): boolean {
  return version.prerelease.length > 0;
}

export function formatVersion(version: Version): string {
  const core = `${version.major}.${version.minor}.${version.patch}`;
  const pre = version.prerelease.length === 0 ? "" : `-${version.prerelease.join(".")}`;
  const build = version.build.length === 0 ? "" : `+${version.build.join(".")}`;
  return `${core}${pre}${build}`;
}
