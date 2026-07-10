import { describe, expect, it } from "vitest";
import { compileRegex, matchesRegex } from "./index.js";

/**
 * The engine is only worth having if it agrees with the one everybody knows.
 *
 * Random patterns are drawn from the supported grammar and run against both
 * this engine and V8's, which must give the same answer. The alphabet is ASCII
 * and `.` is never generated unescaped, because those are the two places the
 * two engines are *allowed* to differ: V8's `.` excludes newline, and V8
 * without the `u` flag counts code units rather than code points.
 *
 * A pattern this engine rejects (`a**`, which V8 accepts under Annex B) is
 * skipped rather than failed: refusing to compile is the safe direction.
 */

/** A seeded LCG, so a failure names a pattern that can be reproduced. */
function random(seed: number): () => number {
  let state = seed;
  return () => {
    state = (state * 1_103_515_245 + 12_345) & 0x7fff_ffff;
    return state / 0x7fff_ffff;
  };
}

const ALPHABET = ["a", "b", "c", "1", "2", "-", "."];
const SHORTHANDS = ["\\d", "\\D", "\\w", "\\W"];
const CLASSES = ["[abc]", "[^abc]", "[a-c1-2]", "[^a-c]", "[\\d-]", "[-a]", "[a-]"];

function generator(next: () => number): { pattern: () => string; input: () => string } {
  const pick = <T>(values: readonly T[]): T => values[Math.floor(next() * values.length)]!;

  const atom = (depth: number): string => {
    const roll = next();
    if (depth < 3 && roll < 0.14) return `(${alternation(depth + 1)})`;
    if (depth < 3 && roll < 0.2) return `(?:${alternation(depth + 1)})`;
    if (roll < 0.34) return pick(SHORTHANDS);
    if (roll < 0.46) return pick(CLASSES);
    if (roll < 0.5) return "\\.";
    const char = pick(ALPHABET);
    return char === "." ? "\\." : char;
  };

  const quantified = (depth: number): string => {
    const body = atom(depth);
    const roll = next();
    if (roll < 0.14) return `${body}*`;
    if (roll < 0.28) return `${body}+`;
    if (roll < 0.38) return `${body}?`;
    if (roll < 0.45) return `${body}{${Math.floor(next() * 3)},${2 + Math.floor(next() * 3)}}`;
    if (roll < 0.5) return `${body}{${1 + Math.floor(next() * 2)}}`;
    return body;
  };

  const concatenation = (depth: number): string => {
    const count = 1 + Math.floor(next() * 4);
    let out = "";
    for (let i = 0; i < count; i++) out += quantified(depth);
    return out;
  };

  const alternation = (depth: number): string => {
    const count = 1 + Math.floor(next() * 3);
    const parts: string[] = [];
    for (let i = 0; i < count; i++) parts.push(concatenation(depth));
    return parts.join("|");
  };

  return {
    pattern: () => {
      let source = alternation(0);
      if (next() < 0.35) source = `^${source}`;
      if (next() < 0.35) source = `${source}$`;
      return source;
    },
    input: () => {
      const count = Math.floor(next() * 7);
      let out = "";
      for (let i = 0; i < count; i++) out += pick(ALPHABET);
      return out;
    },
  };
}

describe("agreement with V8", () => {
  it("gives the same answer as RegExp on 40000 random pattern/input pairs", () => {
    const next = random(0x5eed);
    const { pattern, input } = generator(next);

    let checked = 0;
    let skipped = 0;

    for (let i = 0; i < 10_000; i++) {
      const source = pattern();

      let native: RegExp;
      try {
        native = new RegExp(source);
      } catch {
        skipped++;
        continue;
      }

      let ours;
      try {
        ours = compileRegex(source);
      } catch {
        // We reject some patterns V8 accepts. Refusing to compile is safe.
        skipped++;
        continue;
      }

      for (let j = 0; j < 4; j++) {
        const text = input();
        checked++;
        expect(matchesRegex(ours, text), `pattern ${source} against "${text}"`).toBe(native.test(text));
      }
    }

    // A generator that only ever produced rejects would pass vacuously.
    expect(checked).toBeGreaterThan(30_000);
    expect(skipped).toBeLessThan(2_000);
  });
});
