import { MAX_PROGRAM_LENGTH, type Program, compile } from "./compile.js";
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
 *
 * Bounded by instructions as well as by entries. A hundred and twenty-eight
 * maximal programs is tens of megabytes, and a project owner can write as many
 * cleanup rules as they like: counting entries alone would let one of them
 * exhaust the isolate's memory. A realistic tag pattern compiles to fewer than
 * a hundred instructions, so neither bound is reached in practice.
 */
const CACHE_LIMIT = 128;
const CACHE_INSTRUCTION_BUDGET = 4 * MAX_PROGRAM_LENGTH;

const cache = new Map<string, Regex | null>();
let cachedInstructions = 0;

/** Oldest first, until both bounds hold. A `null` entry costs no instructions. */
function evict(): void {
  while (cache.size > CACHE_LIMIT || cachedInstructions > CACHE_INSTRUCTION_BUDGET) {
    const oldest = cache.keys().next();
    if (oldest.done) return;
    cachedInstructions -= cache.get(oldest.value)?.program.length ?? 0;
    cache.delete(oldest.value);
  }
}

function cached(source: string): Regex | null {
  const hit = cache.get(source);
  if (hit !== undefined || cache.has(source)) return hit ?? null;

  const regex = tryCompileRegex(source);
  cache.set(source, regex);
  cachedInstructions += regex?.program.length ?? 0;
  evict();
  return regex;
}

/** What the compiled cache currently holds. For tests and diagnostics. */
export function cacheStats(): { entries: number; instructions: number } {
  return { entries: cache.size, instructions: cachedInstructions };
}

/** Whether `source` matches `input`. A pattern that does not compile matches nothing. */
export function testRegex(source: string, input: string): boolean {
  const regex = cached(source);
  return regex !== null && search(regex.program, input);
}
