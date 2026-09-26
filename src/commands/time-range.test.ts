import { InvalidArgumentError } from "commander";
import { describe, expect, it } from "vitest";
import { describeTimeRange, parseTimeBound, resolveTimeRange, timeBound } from "./time-range";

const now = new Date("2026-09-25T12:00:00.000Z");
const start = { endOfDay: false, now };
const end = { endOfDay: true, now };

describe("parseTimeBound", () => {
  it.each([
    ["24h", "2026-09-24T12:00:00.000Z"],
    ["7d", "2026-09-18T12:00:00.000Z"],
    ["2w", "2026-09-11T12:00:00.000Z"],
    ["0h", "2026-09-25T12:00:00.000Z"],
    [" 7d ", "2026-09-18T12:00:00.000Z"],
  ])("counts %j back from now", (value, expected) => {
    expect(parseTimeBound(value, start).toISOString()).toBe(expected);
  });

  it("reads a date as UTC midnight, or the next midnight at end of day", () => {
    expect(parseTimeBound("2026-09-01", start).toISOString()).toBe("2026-09-01T00:00:00.000Z");
    expect(parseTimeBound("2026-09-01", end).toISOString()).toBe("2026-09-02T00:00:00.000Z");
    expect(parseTimeBound("2026-12-31", end).toISOString()).toBe("2027-01-01T00:00:00.000Z");
  });

  it.each([
    ["2026-09-01T14:00:00Z", "2026-09-01T14:00:00.000Z"],
    ["2026-09-01t14:00z", "2026-09-01T14:00:00.000Z"],
    ["2026-09-01 14:00:30", "2026-09-01T14:00:30.000Z"],
    ["2026-09-01T14:00:00.123456Z", "2026-09-01T14:00:00.123Z"],
    ["2026-09-01T14:00:00.5Z", "2026-09-01T14:00:00.500Z"],
    ["2026-09-01T14:00:00+05:30", "2026-09-01T08:30:00.000Z"],
    ["2026-09-01T14:00:00-0800", "2026-09-01T22:00:00.000Z"],
    ["2026-09-01T14:00+02", "2026-09-01T12:00:00.000Z"],
  ])("parses ISO datetime %j (naive reads as UTC)", (value, expected) => {
    expect(parseTimeBound(value, end).toISOString()).toBe(expected);
  });

  it.each([
    "",
    "yesterday",
    "7",
    "7m",
    "-7d",
    "Sept 1 2026",
    "2026-9-1",
    "2026-02-30",
    "2026-13-01",
    "2026-09-01T24:00:00Z",
    "2026-09-01T14:60:00Z",
    "2026-09-01T14:00:60Z",
    "2026-09-01T14:00:00+24:00",
    "2026-09-01T14:00:00+05:60",
    "99999999999999999999d",
  ])("rejects %j", (value) => {
    expect(() => parseTimeBound(value, start)).toThrow(InvalidArgumentError);
  });
});

describe("timeBound", () => {
  it("returns the trimmed raw value for a valid bound", () => {
    expect(timeBound(" 7d ")).toBe("7d");
  });

  it("throws InvalidArgumentError for a malformed bound", () => {
    expect(() => timeBound("soon")).toThrow(/must be a duration/);
  });
});

describe("resolveTimeRange", () => {
  it("returns an empty range when neither bound is set", () => {
    expect(resolveTimeRange(undefined, undefined, now)).toEqual({
      since: undefined,
      until: undefined,
    });
  });

  it("resolves an until date to the end of that day", () => {
    const range = resolveTimeRange("2026-09-01", "2026-09-01", now);
    expect(range.since?.toISOString()).toBe("2026-09-01T00:00:00.000Z");
    expect(range.until?.toISOString()).toBe("2026-09-02T00:00:00.000Z");
  });

  it("rejects equal relative bounds instead of leaving a sliver window", () => {
    expect(() => resolveTimeRange("7d", "7d", now)).toThrow("--since must be earlier than --until");
  });

  it("rejects since after until", () => {
    expect(() => resolveTimeRange("24h", "7d", now)).toThrow(InvalidArgumentError);
  });

  it("defaults now to the current time", () => {
    const range = resolveTimeRange("0h", undefined);
    expect(Math.abs((range.since?.getTime() ?? 0) - Date.now())).toBeLessThan(5000);
  });
});

describe("describeTimeRange", () => {
  it("labels each set side at minute precision", () => {
    const since = new Date("2026-09-21T14:00:59Z");
    const until = new Date("2026-09-22T00:00:00Z");
    expect(describeTimeRange({ since, until })).toBe(
      "since 2026-09-21T14:00Z and before 2026-09-22T00:00Z",
    );
    expect(describeTimeRange({ since })).toBe("since 2026-09-21T14:00Z");
    expect(describeTimeRange({ until })).toBe("before 2026-09-22T00:00Z");
    expect(describeTimeRange({})).toBe("");
  });
});
