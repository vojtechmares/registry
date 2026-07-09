import { describe, expect, it } from "vitest";
import { isValidCron, nextRun, parseCron } from "./cron.js";

/** Every instant here is UTC, which is the only timezone a Worker's cron knows. */
const at = (iso: string): number => Date.parse(`${iso}Z`);
const next = (expression: string, from: string): string | null => {
  const result = nextRun(expression, at(from));
  return result === null ? null : new Date(result).toISOString().replace(".000Z", "Z");
};

describe("parseCron", () => {
  it("accepts the five standard fields", () => {
    expect(parseCron("0 3 * * *")).not.toBeNull();
    expect(parseCron("*/15 * * * *")).not.toBeNull();
    expect(parseCron("0 0 1 1 *")).not.toBeNull();
  });

  it("accepts ranges, steps and lists", () => {
    expect(parseCron("0-30 * * * *")).not.toBeNull();
    expect(parseCron("0-30/5 * * * *")).not.toBeNull();
    expect(parseCron("1,2,3 * * * *")).not.toBeNull();
    expect(parseCron("0 0,12 * * 1-5")).not.toBeNull();
  });

  it("accepts month and weekday names, in any case", () => {
    expect(parseCron("0 0 1 JAN *")).not.toBeNull();
    expect(parseCron("0 0 * * sun")).not.toBeNull();
    expect(parseCron("0 0 * * Mon-Fri")).not.toBeNull();
  });

  it("accepts the macros", () => {
    for (const macro of ["@hourly", "@daily", "@midnight", "@weekly", "@monthly", "@yearly", "@annually"]) {
      expect(parseCron(macro)).not.toBeNull();
    }
  });

  it("rejects the wrong number of fields", () => {
    expect(parseCron("* * * *")).toBeNull();
    expect(parseCron("* * * * * *")).toBeNull();
    expect(parseCron("")).toBeNull();
  });

  it("rejects a value outside its field's range", () => {
    expect(parseCron("60 * * * *")).toBeNull();
    expect(parseCron("* 24 * * *")).toBeNull();
    expect(parseCron("* * 32 * *")).toBeNull();
    expect(parseCron("* * * 13 *")).toBeNull();
    expect(parseCron("* * * * 8")).toBeNull();
    expect(parseCron("* * 0 * *")).toBeNull();
  });

  it("rejects an inverted range and a zero step", () => {
    expect(parseCron("30-10 * * * *")).toBeNull();
    expect(parseCron("*/0 * * * *")).toBeNull();
  });

  it("rejects what is not a cron expression", () => {
    expect(parseCron("every minute")).toBeNull();
    expect(parseCron("@sometimes")).toBeNull();
    expect(parseCron("* * * * mon-")).toBeNull();
  });
});

describe("isValidCron", () => {
  it("agrees with parseCron", () => {
    expect(isValidCron("0 3 * * *")).toBe(true);
    expect(isValidCron("nonsense")).toBe(false);
  });
});

describe("nextRun", () => {
  it("finds the next matching minute, strictly after the instant given", () => {
    expect(next("* * * * *", "2026-07-10T12:30:00")).toBe("2026-07-10T12:31:00Z");
    expect(next("* * * * *", "2026-07-10T12:30:30")).toBe("2026-07-10T12:31:00Z");
  });

  it("never returns the instant it was given, even when it matches", () => {
    expect(next("30 12 * * *", "2026-07-10T12:30:00")).toBe("2026-07-11T12:30:00Z");
  });

  it("rolls over the hour, the day, the month and the year", () => {
    expect(next("0 * * * *", "2026-07-10T12:30:00")).toBe("2026-07-10T13:00:00Z");
    expect(next("0 0 * * *", "2026-07-10T12:30:00")).toBe("2026-07-11T00:00:00Z");
    expect(next("0 0 1 * *", "2026-07-10T12:30:00")).toBe("2026-08-01T00:00:00Z");
    expect(next("0 0 1 1 *", "2026-07-10T12:30:00")).toBe("2027-01-01T00:00:00Z");
  });

  it("honours a step", () => {
    expect(next("*/15 * * * *", "2026-07-10T12:00:00")).toBe("2026-07-10T12:15:00Z");
    expect(next("*/15 * * * *", "2026-07-10T12:50:00")).toBe("2026-07-10T13:00:00Z");
  });

  it("honours a range with a step", () => {
    expect(next("0-30/10 * * * *", "2026-07-10T12:25:00")).toBe("2026-07-10T12:30:00Z");
    expect(next("0-30/10 * * * *", "2026-07-10T12:35:00")).toBe("2026-07-10T13:00:00Z");
  });

  it("honours a list", () => {
    expect(next("0 6,18 * * *", "2026-07-10T07:00:00")).toBe("2026-07-10T18:00:00Z");
    expect(next("0 6,18 * * *", "2026-07-10T19:00:00")).toBe("2026-07-11T06:00:00Z");
  });

  it("matches a weekday", () => {
    // 2026-07-10 is a Friday; the next Monday is the 13th.
    expect(next("0 0 * * 1", "2026-07-10T12:00:00")).toBe("2026-07-13T00:00:00Z");
  });

  it("accepts 7 as Sunday, as Vixie cron does", () => {
    expect(next("0 0 * * 7", "2026-07-10T12:00:00")).toBe(next("0 0 * * 0", "2026-07-10T12:00:00"));
  });

  it("unions the day-of-month and day-of-week when both are restricted", () => {
    // The Vixie rule: with both restricted, a day matches if *either* does.
    // 2026-07-10 is a Friday. The 13th is both a Monday and the 13th.
    expect(next("0 0 13 * 1", "2026-07-10T12:00:00")).toBe("2026-07-13T00:00:00Z");
    // The next match after that Monday is the following Monday, the 20th.
    expect(next("0 0 13 * 1", "2026-07-13T12:00:00")).toBe("2026-07-20T00:00:00Z");
  });

  it("intersects the day-of-month with the month when the weekday is unrestricted", () => {
    expect(next("0 0 13 7 *", "2026-07-10T12:00:00")).toBe("2026-07-13T00:00:00Z");
    expect(next("0 0 13 7 *", "2026-07-14T12:00:00")).toBe("2027-07-13T00:00:00Z");
  });

  it("treats a day field that admits every value as unrestricted, however it was written", () => {
    // `0-6` matches every weekday, so it restricts nothing and must not drag
    // the day-of-month into a union with it. Vixie cron looks for a literal
    // star here and would union; that is a quirk of how it peeks at the first
    // character, not a rule anybody relies on. Naming every value and naming
    // none of them are the same statement.
    expect(next("0 0 13 * 0-6", "2026-07-10T12:00:00")).toBe("2026-07-13T00:00:00Z");
    expect(next("0 0 13 * *", "2026-07-10T12:00:00")).toBe("2026-07-13T00:00:00Z");
    expect(next("0 0 * * 0-6", "2026-07-10T12:00:00")).toBe("2026-07-11T00:00:00Z");
  });

  it("skips a month that is too short for the day", () => {
    // No 31st in April, so the next 31st is in May.
    expect(next("0 0 31 * *", "2026-04-15T00:00:00")).toBe("2026-05-31T00:00:00Z");
  });

  it("finds February 29th in a leap year", () => {
    expect(next("0 0 29 2 *", "2026-03-01T00:00:00")).toBe("2028-02-29T00:00:00Z");
  });

  it("gives up on a date that never comes rather than looping forever", () => {
    // The 30th of February.
    expect(nextRun("0 0 30 2 *", at("2026-01-01T00:00:00"))).toBeNull();
  });

  it("returns null for an expression that will not parse", () => {
    expect(nextRun("nonsense", at("2026-01-01T00:00:00"))).toBeNull();
  });

  it("expands the macros to what they mean", () => {
    expect(next("@hourly", "2026-07-10T12:30:00")).toBe("2026-07-10T13:00:00Z");
    expect(next("@daily", "2026-07-10T12:30:00")).toBe("2026-07-11T00:00:00Z");
    expect(next("@monthly", "2026-07-10T12:30:00")).toBe("2026-08-01T00:00:00Z");
    expect(next("@yearly", "2026-07-10T12:30:00")).toBe("2027-01-01T00:00:00Z");
    // 2026-07-10 is a Friday, so the next Sunday is the 12th.
    expect(next("@weekly", "2026-07-10T12:30:00")).toBe("2026-07-12T00:00:00Z");
  });

  it("always lands on a whole minute", () => {
    const result = nextRun("* * * * *", at("2026-07-10T12:30:44"));
    expect(result! % 60_000).toBe(0);
  });

  it("moves forward, never backward", () => {
    const from = at("2026-07-10T12:30:00");
    for (const expression of ["* * * * *", "0 3 * * *", "*/7 * * * *", "0 0 1 * *", "0 0 * * 3"]) {
      expect(nextRun(expression, from)!).toBeGreaterThan(from);
    }
  });
});
