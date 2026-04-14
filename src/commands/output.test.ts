import { beforeEach, describe, expect, it, vi } from "vitest";
import { formatDate, printInfo, printTable, truncate } from "./output";

beforeEach(() => {
  vi.restoreAllMocks();
});

describe("truncate", () => {
  it("returns string unchanged when shorter than maxLen", () => {
    expect(truncate("hello", 10)).toBe("hello");
  });

  it("returns string unchanged when exactly maxLen", () => {
    expect(truncate("hello", 5)).toBe("hello");
  });

  it("truncates and adds ellipsis when longer, result length = maxLen", () => {
    const result = truncate("hello world", 6);
    expect(result).toBe("hello…");
    expect(result.length).toBe(6);
  });

  it("returns empty string for empty input", () => {
    expect(truncate("", 10)).toBe("");
  });
});

describe("formatDate", () => {
  it('returns "—" for null', () => {
    expect(formatDate(null)).toBe("—");
  });

  it('returns "—" for undefined', () => {
    expect(formatDate(undefined)).toBe("—");
  });

  it('returns "—" for empty string', () => {
    expect(formatDate("")).toBe("—");
  });

  it("formats ISO date correctly", () => {
    const result = formatDate("2024-03-15T10:30:00Z");
    // Should contain both the month and year
    expect(result).toContain("Mar");
    expect(result).toContain("2024");
  });

  it("handles invalid date string", () => {
    // new Date("not-a-date") produces "Invalid Date"
    const result = formatDate("not-a-date");
    // toLocaleDateString on an invalid date returns "Invalid Date"
    expect(typeof result).toBe("string");
  });
});

describe("printTable", () => {
  it("outputs raw JSON when json+rawData provided", () => {
    const spy = vi.spyOn(console, "log").mockImplementation(() => {});
    const rawData = [{ id: 1, name: "test" }];
    printTable(["ID", "Name"], [["1", "test"]], { json: true, rawData });
    expect(spy).toHaveBeenCalledOnce();
    expect(spy.mock.calls[0][0]).toBe(JSON.stringify(rawData, null, 2));
  });

  it('prints "No results found." for empty rows', () => {
    const spy = vi.spyOn(console, "log").mockImplementation(() => {});
    printTable(["ID", "Name"], []);
    expect(spy).toHaveBeenCalledOnce();
    // The output uses picocolors dim, but the underlying text should contain the message
    const output = spy.mock.calls[0][0] as string;
    expect(output).toContain("No results found.");
  });

  it("prints header + separator + rows", () => {
    const spy = vi.spyOn(console, "log").mockImplementation(() => {});
    printTable(["ID", "Name"], [["1", "Alice"]]);
    // 3 calls: header, separator, one row
    expect(spy).toHaveBeenCalledTimes(3);
  });

  it("pads columns to widest value", () => {
    const spy = vi.spyOn(console, "log").mockImplementation(() => {});
    printTable(["ID", "Name"], [["1", "Alexander"]]);
    // The row output should have "1" padded to at least the width of "ID" (2 chars)
    const rowOutput = spy.mock.calls[2][0] as string;
    // "1" should be padded — the column starts with "1 " (padded to width of "ID")
    expect(rowOutput).toContain("1 ");
    // "Alexander" is wider than "Name", so header should be padded
    const headerOutput = spy.mock.calls[0][0] as string;
    expect(headerOutput).toContain("Name");
  });

  it("handles undefined cells without crashing", () => {
    const spy = vi.spyOn(console, "log").mockImplementation(() => {});
    const rows = [["1", undefined as unknown as string]];
    expect(() => printTable(["ID", "Name"], rows)).not.toThrow();
    // Should still print header + separator + row
    expect(spy).toHaveBeenCalledTimes(3);
  });
});

describe("printInfo", () => {
  it("outputs raw JSON when json+rawData provided", () => {
    const spy = vi.spyOn(console, "log").mockImplementation(() => {});
    const rawData = { id: 1, status: "active" };
    printInfo(
      [
        ["ID", "1"],
        ["Status", "active"],
      ],
      { json: true, rawData },
    );
    expect(spy).toHaveBeenCalledOnce();
    expect(spy.mock.calls[0][0]).toBe(JSON.stringify(rawData, null, 2));
  });

  it("skips entries where value is undefined", () => {
    const spy = vi.spyOn(console, "log").mockImplementation(() => {});
    printInfo([
      ["ID", "1"],
      ["Missing", undefined],
      ["Status", "ok"],
    ]);
    // Only 2 calls — the entry with undefined value is skipped
    expect(spy).toHaveBeenCalledTimes(2);
    const allOutput = spy.mock.calls.map((c) => c[0] as string).join("\n");
    expect(allOutput).toContain("ID");
    expect(allOutput).toContain("Status");
    expect(allOutput).not.toContain("Missing");
  });
});
