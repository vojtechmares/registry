import { describe, expect, it } from "vitest";
import { RegexSyntaxError, compileRegex, isValidRegex, matchesRegex, testRegex } from "./index.js";

/** `testRegex` compiles and searches; every case here reads as "does this pattern find this string". */
const hits = (pattern: string, input: string): boolean => testRegex(pattern, input);

describe("literals", () => {
  it("finds a literal anywhere in the input", () => {
    expect(hits("rc", "v1.0-rc1")).toBe(true);
    expect(hits("rc", "v1.0")).toBe(false);
  });

  it("matches the empty pattern against anything", () => {
    expect(hits("", "")).toBe(true);
    expect(hits("", "anything")).toBe(true);
  });

  it("is case sensitive", () => {
    expect(hits("RC", "v1-rc1")).toBe(false);
  });

  it("compares by code point, so astral characters are one character", () => {
    expect(hits("^.$", "😀")).toBe(true);
    expect(hits("^..$", "😀")).toBe(false);
  });
});

describe("anchors", () => {
  it("^ pins to the start and $ to the end", () => {
    expect(hits("^v1", "v1.2")).toBe(true);
    expect(hits("^v1", "xv1")).toBe(false);
    expect(hits("v1$", "xv1")).toBe(true);
    expect(hits("v1$", "v1x")).toBe(false);
  });

  it("anchored at both ends demands the whole input", () => {
    expect(hits("^v1$", "v1")).toBe(true);
    expect(hits("^v1$", "v1.2")).toBe(false);
  });

  it("matches an empty input only when the pattern can be empty", () => {
    expect(hits("^$", "")).toBe(true);
    expect(hits("^$", "x")).toBe(false);
  });
});

describe("character classes", () => {
  it("matches a member and rejects a non-member", () => {
    expect(hits("^[abc]$", "b")).toBe(true);
    expect(hits("^[abc]$", "d")).toBe(false);
  });

  it("supports ranges", () => {
    expect(hits("^[a-f0-9]+$", "beef42")).toBe(true);
    expect(hits("^[a-f0-9]+$", "beefz")).toBe(false);
  });

  it("negates with a leading caret", () => {
    expect(hits("^[^0-9]+$", "latest")).toBe(true);
    expect(hits("^[^0-9]+$", "v1")).toBe(false);
  });

  it("takes a ] in first position, and a - at either edge, literally", () => {
    expect(hits("^[]]$", "]")).toBe(true);
    expect(hits("^[-a]+$", "a-a")).toBe(true);
    expect(hits("^[a-]+$", "a-a")).toBe(true);
  });

  it("honours escapes inside a class", () => {
    expect(hits("^[\\d.]+$", "1.2.3")).toBe(true);
    expect(hits("^[\\]]$", "]")).toBe(true);
    expect(hits("^[\\^]$", "^")).toBe(true);
  });

  it("rejects an unterminated or empty class", () => {
    expect(isValidRegex("[abc")).toBe(false);
    expect(isValidRegex("[]")).toBe(false);
    expect(isValidRegex("[^]")).toBe(false);
  });

  it("rejects a reversed range", () => {
    expect(isValidRegex("[z-a]")).toBe(false);
  });
});

describe("escapes", () => {
  it("supports the shorthand classes and their complements", () => {
    expect(hits("^\\d+$", "123")).toBe(true);
    expect(hits("^\\D+$", "abc")).toBe(true);
    expect(hits("^\\w+$", "a_1")).toBe(true);
    expect(hits("^\\W+$", "-.")).toBe(true);
    expect(hits("^\\s$", " ")).toBe(true);
    expect(hits("^\\S$", "x")).toBe(true);
  });

  it("takes an escaped metacharacter literally", () => {
    expect(hits("^a\\.b$", "a.b")).toBe(true);
    expect(hits("^a\\.b$", "axb")).toBe(false);
    expect(hits("^a\\\\b$", "a\\b")).toBe(true);
    expect(hits("^\\$\\^\\+\\*\\?\\(\\)\\[\\]\\{\\}\\|$", "$^+*?()[]{}|")).toBe(true);
  });

  it("supports \\xHH and \\uHHHH", () => {
    expect(hits("^\\x41$", "A")).toBe(true);
    expect(hits("^\\u0041$", "A")).toBe(true);
  });

  it("rejects an unknown escape rather than guessing", () => {
    expect(isValidRegex("\\q")).toBe(false);
    expect(isValidRegex("\\")).toBe(false);
  });

  it("rejects a backreference", () => {
    expect(isValidRegex("(a)\\1")).toBe(false);
  });
});

describe("quantifiers", () => {
  it("applies * + and ?", () => {
    expect(hits("^ab*$", "a")).toBe(true);
    expect(hits("^ab*$", "abbb")).toBe(true);
    expect(hits("^ab+$", "a")).toBe(false);
    expect(hits("^ab+$", "ab")).toBe(true);
    expect(hits("^ab?$", "a")).toBe(true);
    expect(hits("^ab?$", "abb")).toBe(false);
  });

  it("applies counted repetition", () => {
    expect(hits("^a{3}$", "aaa")).toBe(true);
    expect(hits("^a{3}$", "aa")).toBe(false);
    expect(hits("^a{2,}$", "aaaa")).toBe(true);
    expect(hits("^a{2,}$", "a")).toBe(false);
    expect(hits("^a{2,4}$", "aa")).toBe(true);
    expect(hits("^a{2,4}$", "aaaa")).toBe(true);
    expect(hits("^a{2,4}$", "aaaaa")).toBe(false);
    expect(hits("^a{0,1}$", "")).toBe(true);
  });

  it("treats a brace that is not a quantifier as a literal", () => {
    expect(hits("^a{b$", "a{b")).toBe(true);
    expect(hits("^a{,2}$", "a{,2}")).toBe(true);
  });

  it("rejects a quantifier with nothing to repeat", () => {
    expect(isValidRegex("*a")).toBe(false);
    expect(isValidRegex("(+)")).toBe(false);
    expect(isValidRegex("a|*")).toBe(false);
  });

  it("rejects a doubled quantifier, which in a backtracking engine is the bomb", () => {
    expect(isValidRegex("a**")).toBe(false);
    expect(isValidRegex("a+*")).toBe(false);
    expect(isValidRegex("a{2}{3}")).toBe(false);
  });

  it("rejects a reversed or oversized bound", () => {
    expect(isValidRegex("a{3,2}")).toBe(false);
    expect(isValidRegex("a{100000}")).toBe(false);
  });
});

describe("groups and alternation", () => {
  it("alternates", () => {
    expect(hits("^(rc|beta)$", "rc")).toBe(true);
    expect(hits("^(rc|beta)$", "beta")).toBe(true);
    expect(hits("^(rc|beta)$", "alpha")).toBe(false);
  });

  it("alternates with an empty branch", () => {
    expect(hits("^a(b|)$", "a")).toBe(true);
    expect(hits("^a(b|)$", "ab")).toBe(true);
  });

  it("quantifies a group", () => {
    expect(hits("^(ab)+$", "abab")).toBe(true);
    expect(hits("^(ab)+$", "aba")).toBe(false);
  });

  it("accepts a non-capturing group", () => {
    expect(hits("^(?:ab)+$", "abab")).toBe(true);
  });

  it("gives alternation the lowest precedence", () => {
    expect(hits("^ab|cd$", "ab")).toBe(true);
    expect(hits("^ab|cd$", "cd")).toBe(true);
  });

  it("rejects an unbalanced parenthesis", () => {
    expect(isValidRegex("(a")).toBe(false);
    expect(isValidRegex("a)")).toBe(false);
  });

  it("rejects lookaround, which cannot be simulated without backtracking", () => {
    expect(isValidRegex("(?=a)")).toBe(false);
    expect(isValidRegex("(?!a)")).toBe(false);
    expect(isValidRegex("(?<=a)")).toBe(false);
    expect(isValidRegex("(?<name>a)")).toBe(false);
  });
});

describe("tag patterns an operator would actually write", () => {
  it.each([
    ["^v\\d+\\.\\d+\\.\\d+$", "v1.20.3", true],
    ["^v\\d+\\.\\d+\\.\\d+$", "v1.20.3-rc1", false],
    ["^\\d+\\.\\d+\\.\\d+-(rc|beta)\\d*$", "1.2.3-rc4", true],
    ["^\\d+\\.\\d+\\.\\d+-(rc|beta)\\d*$", "1.2.3", false],
    ["^(latest|stable)$", "latest", true],
    ["^sha-[0-9a-f]{7,40}$", "sha-a1b2c3d", true],
    ["^sha-[0-9a-f]{7,40}$", "sha-xyz", false],
    ["-SNAPSHOT$", "1.0-SNAPSHOT", true],
    ["^pr-\\d+$", "pr-1234", true],
  ])("%s against %s", (pattern, input, expected) => {
    expect(hits(pattern, input)).toBe(expected);
  });
});

describe("no backtracking", () => {
  // Each of these is exponential on a backtracking engine. The Thompson
  // simulation never revisits a state at a position, so each is linear.
  // Anchored where an unanchored form would match the empty string at the end.
  const bombs = ["^(a+)+$", "^(a|a)*$", "(a*)*b", "^(a|aa)+$", "^(a+)+(b+)+$", "(x+x+)+y"];

  it.each(bombs)("%s finishes on a defeating input", (pattern) => {
    const input = "a".repeat(60).concat("!");
    const started = performance.now();
    expect(hits(pattern, input)).toBe(false);
    expect(performance.now() - started).toBeLessThan(100);
  });

  it("stays linear as the input grows", () => {
    const pattern = "^(a+)+$";
    const time = (n: number): number => {
      const input = "a".repeat(n) + "b";
      const started = performance.now();
      hits(pattern, input);
      return performance.now() - started;
    };
    time(500); // warm
    const small = Math.max(time(2_000), 0.5);
    const large = time(8_000);
    // Four times the input, and generously under sixteen times the work.
    expect(large / small).toBeLessThan(16);
  });

  it("terminates on a nullable body under a star", () => {
    expect(hits("^(a*)*$", "aaa")).toBe(true);
    expect(hits("^(|a)*$", "aaa")).toBe(true);
    expect(hits("^(a?)*$", "")).toBe(true);
  });
});

describe("limits", () => {
  it("rejects a source longer than the cap", () => {
    expect(isValidRegex("a".repeat(512))).toBe(true);
    expect(isValidRegex("a".repeat(513))).toBe(false);
  });

  it("rejects a pattern whose counted repeats would explode the program", () => {
    expect(isValidRegex("(a{100}){100}")).toBe(false);
  });

  it("accepts a large but bounded program", () => {
    expect(isValidRegex("a{1000}")).toBe(true);
  });
});

describe("api", () => {
  it("compileRegex throws a RegexSyntaxError, naming the offset", () => {
    expect(() => compileRegex("a(b")).toThrow(RegexSyntaxError);
    expect(() => compileRegex("a(b")).toThrow(/unbalanced/i);
  });

  it("matchesRegex reuses a compiled program", () => {
    const regex = compileRegex("^v\\d+$");
    expect(matchesRegex(regex, "v1")).toBe(true);
    expect(matchesRegex(regex, "v")).toBe(false);
    expect(regex.source).toBe("^v\\d+$");
  });

  it("testRegex reports false for a pattern that does not compile", () => {
    expect(testRegex("(a", "a")).toBe(false);
  });

  it("isValidRegex agrees with compileRegex", () => {
    expect(isValidRegex("^v\\d+$")).toBe(true);
    expect(isValidRegex("(a")).toBe(false);
  });
});
