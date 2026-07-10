import { describe, expect, it } from "vitest";
import { compileRegex, isValidRegex, testRegex } from "./index.js";

/**
 * The parser and the compiler are mutually recursive, and neither carries a
 * depth counter. `MAX_SOURCE_LENGTH` is what bounds them: a source of 512
 * characters cannot nest more than 512 deep, and 512 levels is nothing.
 *
 * These pin that argument. A pattern that overflowed the stack here would throw
 * a `RangeError` rather than a `RegexSyntaxError`, and the route that reports
 * the message would answer 500 where it means 400.
 */
describe("recursion depth", () => {
  it("compiles a maximally nested source without overflowing the stack", () => {
    const source = "(".repeat(255) + "a" + ")".repeat(255);
    expect(source.length).toBeLessThanOrEqual(512);
    expect(() => compileRegex(source)).not.toThrow();
    expect(testRegex(source, "a")).toBe(true);
  });

  it("rejects 512 unbalanced parentheses without overflowing the stack", () => {
    expect(isValidRegex("(".repeat(512))).toBe(false);
  });

  it("terminates on deeply nested stars over a nullable body", () => {
    const source = "(".repeat(120) + "a" + ")*".repeat(120);
    expect(source.length).toBeLessThanOrEqual(512);

    // The whole expression is nullable and matching is a search, so it finds the
    // empty match anywhere - V8 answers the same for the same pattern. What is
    // under test is that the epsilon closure terminates at all.
    expect(testRegex(source, "aaaa")).toBe(true);
    expect(testRegex(source, "b")).toBe(true);
    expect(testRegex(`^(?:${source})$`, "b")).toBe(false);
  });

  it("caps a program that nested counted repeats would explode", () => {
    expect(isValidRegex("(((a{100}){100}){100})")).toBe(false);
  });

  it("compiles the largest legal program without stalling", () => {
    const started = performance.now();
    expect(isValidRegex("a{1000}")).toBe(true);
    expect(performance.now() - started).toBeLessThan(200);
  });
});
