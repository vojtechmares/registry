import {
  ANY,
  type CharSet,
  DIGIT,
  NOT_DIGIT,
  NOT_SPACE,
  NOT_WORD,
  type Range,
  SPACE,
  WORD,
  single,
} from "./charset.js";

/**
 * The syntax this engine accepts, and nothing beyond it.
 *
 * Everything omitted is omitted on purpose. Backreferences and lookaround are
 * what force a matcher to backtrack, and backtracking is what turns a typo in a
 * cleanup rule into a Worker that burns its CPU budget on `(a+)+$`. Without
 * them the pattern compiles to an automaton, and the automaton runs in time
 * linear in the pattern times the input, always.
 */

export type Node =
  | { readonly kind: "empty" }
  | { readonly kind: "set"; readonly set: CharSet }
  | { readonly kind: "concat"; readonly parts: readonly Node[] }
  | { readonly kind: "alt"; readonly options: readonly Node[] }
  | { readonly kind: "repeat"; readonly node: Node; readonly min: number; readonly max: number | null }
  | { readonly kind: "assert"; readonly at: "start" | "end" };

/** Long enough for any tag pattern, short enough that parsing is never the cost. */
export const MAX_SOURCE_LENGTH = 512;
/** `a{1000}` is already absurd; `a{100000}` is an attempt to exhaust memory. */
export const MAX_REPEAT = 1000;

export class RegexSyntaxError extends Error {
  readonly offset: number;

  constructor(message: string, offset: number) {
    super(`${message} at offset ${offset}`);
    this.name = "RegexSyntaxError";
    this.offset = offset;
  }
}

const QUANTIFIER_START = new Set(["*", "+", "?"]);

/** Escapes that stand for a set of characters rather than one. */
const SHORTHAND: Readonly<Record<string, readonly Range[]>> = {
  d: DIGIT,
  D: NOT_DIGIT,
  w: WORD,
  W: NOT_WORD,
  s: SPACE,
  S: NOT_SPACE,
};

/** Escapes that stand for one, unprintable, character. */
const CONTROL: Readonly<Record<string, number>> = {
  n: 0x0a,
  r: 0x0d,
  t: 0x09,
  f: 0x0c,
  v: 0x0b,
  "0": 0x00,
};

class Parser {
  /** Code points, not code units: `😀` is one character to match against. */
  private readonly chars: readonly string[];
  private index = 0;

  constructor(source: string) {
    this.chars = [...source];
  }

  private peek(ahead = 0): string | undefined {
    return this.chars[this.index + ahead];
  }

  private next(): string | undefined {
    return this.chars[this.index++];
  }

  private fail(message: string, offset = this.index): never {
    throw new RegexSyntaxError(message, offset);
  }

  parse(): Node {
    const node = this.parseAlternation();
    if (this.index < this.chars.length) {
      // The only atom that stops `parseConcat` without being consumed.
      this.fail('unbalanced ")"');
    }
    return node;
  }

  private parseAlternation(): Node {
    const options: Node[] = [this.parseConcat()];
    while (this.peek() === "|") {
      this.index++;
      options.push(this.parseConcat());
    }
    return options.length === 1 ? options[0]! : { kind: "alt", options };
  }

  private parseConcat(): Node {
    const parts: Node[] = [];
    for (;;) {
      const char = this.peek();
      if (char === undefined || char === "|" || char === ")") break;
      if (QUANTIFIER_START.has(char)) this.fail(`nothing to repeat before "${char}"`);
      parts.push(this.parseQuantified());
    }

    if (parts.length === 0) return { kind: "empty" };
    return parts.length === 1 ? parts[0]! : { kind: "concat", parts };
  }

  /** An atom, then at most one quantifier. A second quantifier is the bomb, and is refused. */
  private parseQuantified(): Node {
    const atom = this.parseAtom();
    const quantified = this.applyQuantifier(atom);
    if (quantified === atom) return atom;

    const trailing = this.peek();
    if (trailing !== undefined && QUANTIFIER_START.has(trailing)) {
      this.fail(`"${trailing}" would repeat an already repeated expression`);
    }
    if (trailing === "{" && this.readBounds(this.index) !== null) {
      this.fail('"{" would repeat an already repeated expression');
    }
    return quantified;
  }

  private applyQuantifier(node: Node): Node {
    const char = this.peek();

    if (char === "*") {
      this.index++;
      return { kind: "repeat", node, min: 0, max: null };
    }
    if (char === "+") {
      this.index++;
      return { kind: "repeat", node, min: 1, max: null };
    }
    if (char === "?") {
      this.index++;
      return { kind: "repeat", node, min: 0, max: 1 };
    }
    if (char !== "{") return node;

    const bounds = this.readBounds(this.index);
    // `a{b` and `a{,2}` are not quantifiers. JavaScript reads the brace as a
    // literal there, and an operator who typed it meant a literal brace.
    if (bounds === null) return node;

    const { min, max, end } = bounds;
    if (min > MAX_REPEAT || (max !== null && max > MAX_REPEAT)) {
      this.fail(`a repetition count above ${MAX_REPEAT}`, this.index);
    }
    if (max !== null && max < min) this.fail(`the bound {${min},${max}} is reversed`, this.index);

    this.index = end;
    return { kind: "repeat", node, min, max };
  }

  /** Reads `{n}`, `{n,}` or `{n,m}` starting at `start`, without consuming. */
  private readBounds(start: number): { min: number; max: number | null; end: number } | null {
    let at = start + 1; // past the "{"
    const digits = (): string => {
      let out = "";
      for (
        let char = this.chars[at];
        char !== undefined && char >= "0" && char <= "9";
        char = this.chars[at]
      ) {
        out += char;
        at++;
      }
      return out;
    };

    const minText = digits();
    if (minText === "") return null;
    const min = Number(minText);

    let max: number | null = min;
    if (this.chars[at] === ",") {
      at++;
      const maxText = digits();
      max = maxText === "" ? null : Number(maxText);
    }

    if (this.chars[at] !== "}") return null;
    return { min, max, end: at + 1 };
  }

  private parseAtom(): Node {
    const start = this.index;
    const char = this.next();
    if (char === undefined) this.fail("unexpected end of pattern", start);

    if (char === "(") return this.parseGroup(start);
    if (char === "[") return { kind: "set", set: this.parseClass(start) };
    if (char === ".") return { kind: "set", set: ANY };
    if (char === "^") return { kind: "assert", at: "start" };
    if (char === "$") return { kind: "assert", at: "end" };
    if (char === "\\") return { kind: "set", set: this.parseEscape(start) };
    return { kind: "set", set: single(char.codePointAt(0)!) };
  }

  private parseGroup(start: number): Node {
    if (this.peek() === "?") {
      // `(?:` is the only group prefix that does not need capture or backtracking.
      if (this.peek(1) !== ":") this.fail("only the non-capturing group (?: is supported", start);
      this.index += 2;
    }

    const node = this.parseAlternation();
    if (this.next() !== ")") this.fail('unbalanced "("', start);
    return node;
  }

  /**
   * A character class. Ranges are collected positively; `^` negates the whole
   * class at match time, which is why `[^\D]` needs no special handling.
   */
  private parseClass(start: number): CharSet {
    const negated = this.peek() === "^";
    if (negated) this.index++;

    const ranges: Range[] = [];
    let first = true;

    for (;;) {
      const char = this.peek();
      if (char === undefined) this.fail('unterminated "["', start);
      // A "]" in first position is the literal, not the terminator.
      if (char === "]" && !first) {
        this.index++;
        break;
      }
      first = false;

      const at = this.index;
      const member = this.parseClassMember();

      // A "-" forms a range only between two single characters, and only when
      // something other than the terminator follows it.
      if (
        member.single !== null &&
        this.peek() === "-" &&
        this.peek(1) !== "]" &&
        this.peek(1) !== undefined
      ) {
        this.index++;
        const upperAt = this.index;
        const upper = this.parseClassMember();
        if (upper.single === null) this.fail("a range endpoint must be a single character", upperAt);
        if (upper.single < member.single) {
          this.fail(
            `the range ${String.fromCodePoint(member.single)}-${String.fromCodePoint(upper.single)} is reversed`,
            at,
          );
        }
        ranges.push([member.single, upper.single]);
        continue;
      }

      ranges.push(...member.ranges);
    }

    if (ranges.length === 0) this.fail("an empty character class matches nothing", start);
    return { negated, ranges };
  }

  private parseClassMember(): { single: number | null; ranges: readonly Range[] } {
    const start = this.index;
    const char = this.next();
    if (char === undefined) this.fail('unterminated "["', start);

    if (char !== "\\") {
      const codePoint = char.codePointAt(0)!;
      return { single: codePoint, ranges: [[codePoint, codePoint]] };
    }

    const set = this.parseEscape(start);
    // A shorthand spans many ranges and cannot be a range endpoint; a literal can.
    const only = set.ranges.length === 1 ? set.ranges[0]! : null;
    const isSingle = only !== null && only[0] === only[1];
    return { single: isSingle ? only[0] : null, ranges: set.ranges };
  }

  /** Called with the backslash already consumed. Returns the set it denotes. */
  private parseEscape(start: number): CharSet {
    const char = this.next();
    if (char === undefined) this.fail("a trailing backslash escapes nothing", start);

    const shorthand = SHORTHAND[char];
    if (shorthand !== undefined) return { negated: false, ranges: shorthand };

    const control = CONTROL[char];
    if (control !== undefined) return single(control);

    if (char === "x") return single(this.readHex(2, start));
    if (char === "u") return single(this.readUnicode(start));

    if (char >= "1" && char <= "9")
      this.fail("a backreference cannot be matched without backtracking", start);
    // Anything else alphanumeric is a feature this engine does not have. Saying
    // so beats silently reading `\b` as a literal "b".
    if (/[a-zA-Z0-9]/.test(char)) this.fail(`unknown escape "\\${char}"`, start);

    return single(char.codePointAt(0)!);
  }

  private readHex(count: number, start: number): number {
    let text = "";
    for (let i = 0; i < count; i++) {
      const char = this.next();
      if (char === undefined || !/[0-9a-fA-F]/.test(char)) this.fail("a malformed hex escape", start);
      text += char;
    }
    return Number.parseInt(text, 16);
  }

  private readUnicode(start: number): number {
    if (this.peek() !== "{") return this.readHex(4, start);

    this.index++;
    let text = "";
    for (let char = this.next(); char !== "}"; char = this.next()) {
      if (char === undefined || !/[0-9a-fA-F]/.test(char)) this.fail("a malformed unicode escape", start);
      text += char;
    }
    const codePoint = text === "" ? Number.NaN : Number.parseInt(text, 16);
    if (!Number.isInteger(codePoint) || codePoint > 0x10_ffff)
      this.fail("a unicode escape out of range", start);
    return codePoint;
  }
}

export function parse(source: string): Node {
  if (source.length > MAX_SOURCE_LENGTH) {
    throw new RegexSyntaxError(
      `the pattern is longer than ${MAX_SOURCE_LENGTH} characters`,
      MAX_SOURCE_LENGTH,
    );
  }
  return new Parser(source).parse();
}
