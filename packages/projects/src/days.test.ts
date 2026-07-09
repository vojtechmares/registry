import { describe, expect, it } from "vitest";
import { dayNumber, dayToIso, fillSeries } from "./days.js";

describe("dayNumber", () => {
  it("counts whole UTC days since the epoch", () => {
    expect(dayNumber(Date.UTC(1970, 0, 1))).toBe(0);
    expect(dayNumber(Date.UTC(1970, 0, 2))).toBe(1);
    expect(dayNumber(Date.UTC(2026, 6, 10))).toBe(20644);
  });

  it("puts the last millisecond of a day in that day", () => {
    expect(dayNumber(Date.UTC(1970, 0, 1, 23, 59, 59, 999))).toBe(0);
    expect(dayNumber(Date.UTC(1970, 0, 2, 0, 0, 0, 0))).toBe(1);
  });
});

describe("dayToIso", () => {
  it("round-trips with dayNumber", () => {
    const ms = Date.UTC(2026, 6, 10);
    expect(dayToIso(dayNumber(ms))).toBe("2026-07-10");
  });

  it("renders the epoch", () => {
    expect(dayToIso(0)).toBe("1970-01-01");
  });
});

describe("fillSeries", () => {
  it("returns one point per day in the window, oldest first", () => {
    const series = fillSeries(10, 3, new Map());
    expect(series.map((point) => point.day)).toEqual([dayToIso(8), dayToIso(9), dayToIso(10)]);
  });

  it("carries the counts it was given and zeroes the rest", () => {
    const counts = new Map([[9, { pulls: 5, pushes: 2, deletes: 1 }]]);
    const series = fillSeries(10, 3, counts);

    expect(series[0]).toEqual({ day: dayToIso(8), pulls: 0, pushes: 0, deletes: 0 });
    expect(series[1]).toEqual({ day: dayToIso(9), pulls: 5, pushes: 2, deletes: 1 });
    expect(series[2]).toEqual({ day: dayToIso(10), pulls: 0, pushes: 0, deletes: 0 });
  });

  it("ignores counts outside the window rather than smearing them into it", () => {
    const counts = new Map([[1, { pulls: 99, pushes: 0, deletes: 0 }]]);
    const series = fillSeries(10, 2, counts);
    expect(series.every((point) => point.pulls === 0)).toBe(true);
  });

  it("always yields the requested number of days", () => {
    expect(fillSeries(100, 1, new Map())).toHaveLength(1);
    expect(fillSeries(100, 30, new Map())).toHaveLength(30);
  });
});
