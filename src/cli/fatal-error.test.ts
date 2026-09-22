import { afterEach, describe, expect, it, vi } from "vitest";
import { printFatalError } from "./fatal-error";

afterEach(() => {
  vi.restoreAllMocks();
});

describe("printFatalError", () => {
  it("prints the message, and a thrown non-Error as-is", () => {
    const stderr = vi.spyOn(console, "error").mockImplementation(() => {});

    printFatalError(new Error("boom"));
    printFatalError("plain failure");

    expect(stderr.mock.calls).toEqual([["boom"], ["plain failure"]]);
  });

  it("adds the tRPC code, path, and status on a second line", () => {
    const stderr = vi.spyOn(console, "error").mockImplementation(() => {});
    const error = Object.assign(new Error("[object Object]"), {
      data: { code: "NOT_FOUND", path: "docs.list", httpStatus: 404 },
    });

    printFatalError(error);

    expect(stderr.mock.calls).toEqual([
      ["[object Object]"],
      ["code=NOT_FOUND path=docs.list status=404"],
    ]);
  });
});
