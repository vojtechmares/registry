import { type Program, compile } from "./compile.js";
import { search } from "./exec.js";
import { parse } from "./parse.js";

export { MAX_PROGRAM_LENGTH } from "./compile.js";
export { MAX_REPEAT, MAX_SOURCE_LENGTH, RegexSyntaxError } from "./parse.js";

/**
 * A regular expression that cannot backtrack.
 *
 * The supported syntax is the part of the language that an automaton can
 * accept: literals, `.`, character classes, the shorthands `\d \D \w \W \s \S`,
 * `*` `+` `?` `{n,m}`, alternation, groups, and the anchors `^` and `$`.
 * Backreferences and lookaround are rejected at compile time - they are the
 * features that require a backtracking matcher, and a backtracking matcher is
 * how a cleanup rule typed into a form becomes a Worker pinned at 100% CPU.
 *
 * Matching is a search, as `RegExp.prototype.test` is: `rc` finds `v1-rc1`.
 * Anchor with `^` and `$` to demand the whole string.
 */
export interface Regex {
  readonly source: string;
  readonly program: Program;
}

/** Throws `RegexSyntaxError` if `source` is not a pattern this engine accepts. */
export function compileRegex(source: string): Regex {
  return { source, program: compile(parse(source)) };
}

export function tryCompileRegex(source: string): Regex | null {
  try {
    return compileRegex(source);
  } catch {
    return null;
  }
}

export function isValidRegex(source: string): boolean {
  return tryCompileRegex(source) !== null;
}

export function matchesRegex(regex: Regex, input: string): boolean {
  return search(regex.program, input);
}

/**
 * Compiled patterns, kept because a cleanup rule is matched against every tag
 * in a repository and recompiling per tag is the only cost worth avoiding here.
 * A source that does not compile is cached as `null`, so a broken rule is not
 * re-parsed once per tag either.
 */
const CACHE_LIMIT = 128;
const cache = new Map<string, Regex | null>();

function cached(source: string): Regex | null {
  const hit = cache.get(source);
  if (hit !== undefined || cache.has(source)) return hit ?? null;

  const regex = tryCompileRegex(source);
  if (cache.size >= CACHE_LIMIT) {
    // Insertion order: the oldest entry goes. A cleanup run touches a handful
    // of rules, so this only ever evicts across unrelated projects.
    const oldest = cache.keys().next();
    if (!oldest.done) cache.delete(oldest.value);
  }
  cache.set(source, regex);
  return regex;
}

/** Whether `source` matches `input`. A pattern that does not compile matches nothing. */
export function testRegex(source: string, input: string): boolean {
  const regex = cached(source);
  return regex !== null && search(regex.program, input);
}
