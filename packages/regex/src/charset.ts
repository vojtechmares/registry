/**
 * A set of code points, as a list of inclusive ranges.
 *
 * `negated` is set only by `[^...]`: the shorthand complements (`\D`, `\W`,
 * `\S`) carry their own inverted ranges instead, so that a class may union them
 * with anything else without having to reason about a nested negation.
 */

export const MAX_CODE_POINT = 0x10_ffff;

export type Range = readonly [number, number];

export interface CharSet {
  readonly negated: boolean;
  readonly ranges: readonly Range[];
}

export function single(codePoint: number): CharSet {
  return { negated: false, ranges: [[codePoint, codePoint]] };
}

/** Every code point. What `.` compiles to; a tag never contains a newline. */
export const ANY: CharSet = { negated: false, ranges: [[0, MAX_CODE_POINT]] };

/** Sorts, merges touching ranges, and inverts over the whole code-point space. */
export function complement(ranges: readonly Range[]): Range[] {
  const merged: Array<[number, number]> = [];
  for (const [lo, hi] of [...ranges].toSorted((a, b) => a[0] - b[0])) {
    const last = merged.at(-1);
    // `hi + 1` so that [0,9] and [10,20] merge rather than leaving an empty gap.
    if (last !== undefined && lo <= last[1] + 1) last[1] = Math.max(last[1], hi);
    else merged.push([lo, hi]);
  }

  const inverted: Range[] = [];
  let next = 0;
  for (const [lo, hi] of merged) {
    if (lo > next) inverted.push([next, lo - 1]);
    next = hi + 1;
  }
  if (next <= MAX_CODE_POINT) inverted.push([next, MAX_CODE_POINT]);
  return inverted;
}

const DIGIT_RANGES: readonly Range[] = [[0x30, 0x39]];
const WORD_RANGES: readonly Range[] = [
  [0x30, 0x39],
  [0x41, 0x5a],
  [0x5f, 0x5f],
  [0x61, 0x7a],
];
// Tab through carriage return, space, no-break space, and the byte-order mark.
// Deliberately not the full Unicode `\p{White_Space}`: a tag is ASCII.
const SPACE_RANGES: readonly Range[] = [
  [0x09, 0x0d],
  [0x20, 0x20],
  [0xa0, 0xa0],
  [0xfe_ff, 0xfe_ff],
];

export const DIGIT: readonly Range[] = DIGIT_RANGES;
export const NOT_DIGIT: readonly Range[] = complement(DIGIT_RANGES);
export const WORD: readonly Range[] = WORD_RANGES;
export const NOT_WORD: readonly Range[] = complement(WORD_RANGES);
export const SPACE: readonly Range[] = SPACE_RANGES;
export const NOT_SPACE: readonly Range[] = complement(SPACE_RANGES);

export function inSet(set: CharSet, codePoint: number): boolean {
  let hit = false;
  for (const [lo, hi] of set.ranges) {
    if (codePoint >= lo && codePoint <= hi) {
      hit = true;
      break;
    }
  }
  return set.negated ? !hit : hit;
}
