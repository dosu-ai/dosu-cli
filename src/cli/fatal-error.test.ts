import { afterEach, describe, expect, it, vi } from "vitest";
import { fatalErrorDiagnostics, printFatalError } from "./fatal-error";

afterEach(() => {
  vi.restoreAllMocks();
});

function trpcError(data: Record<string, unknown>, message = "[object Object]"): Error {
  return Object.assign(new Error(message), { data });
}

describe("printFatalError", () => {
  it("prints the message, and a thrown non-Error as-is", () => {
    const stderr = vi.spyOn(console, "error").mockImplementation(() => {});

    printFatalError(new Error("boom"));
    printFatalError("plain failure");

    expect(stderr.mock.calls).toEqual([["boom"], ["plain failure"]]);
  });

  it("adds the tRPC code, path, and status on a second line", () => {
    const stderr = vi.spyOn(console, "error").mockImplementation(() => {});
    const error = trpcError({ code: "NOT_FOUND", path: "docs.list", httpStatus: 404 });

    printFatalError(error);

    expect(stderr.mock.calls).toEqual([
      ["[object Object]"],
      ["code=NOT_FOUND path=docs.list status=404"],
    ]);
  });

  it("adds the server request ID after the status when present", () => {
    const stderr = vi.spyOn(console, "error").mockImplementation(() => {});

    printFatalError(
      trpcError(
        {
          code: "INTERNAL_SERVER_ERROR",
          path: "review.listPending",
          httpStatus: 500,
          requestId: "sfo1::iad1::abcde-1695000000000-0123456789ab",
        },
        "Internal server error",
      ),
    );

    expect(stderr.mock.calls).toEqual([
      ["Internal server error"],
      [
        "code=INTERNAL_SERVER_ERROR path=review.listPending status=500 " +
          "request_id=sfo1::iad1::abcde-1695000000000-0123456789ab",
      ],
    ]);
  });
});

describe("fatalErrorDiagnostics", () => {
  it("prints a request ID even when the other fields are absent", () => {
    expect(fatalErrorDiagnostics(trpcError({ requestId: "req-1" }))).toBe("request_id=req-1");
  });

  it("returns nothing for errors without tRPC data", () => {
    expect(fatalErrorDiagnostics(new Error("boom"))).toBeUndefined();
    expect(fatalErrorDiagnostics(null)).toBeUndefined();
    expect(fatalErrorDiagnostics("text")).toBeUndefined();
    expect(fatalErrorDiagnostics(trpcError({}))).toBeUndefined();
    expect(fatalErrorDiagnostics(Object.assign(new Error("x"), { data: "nope" }))).toBeUndefined();
  });

  it.each([
    ["null", null],
    ["empty", ""],
    ["whitespace", "   "],
    ["number", 42],
    ["object", { id: "req-1" }],
    ["control characters", "req\u001b[31m-1"],
    ["newline", "req-1\nforged: line"],
    ["spaces", "req 1"],
    ["too long", "r".repeat(129)],
  ])("omits a malformed (%s) request ID and keeps the rest", (_label, requestId) => {
    expect(
      fatalErrorDiagnostics(trpcError({ code: "NOT_FOUND", httpStatus: 404, requestId })),
    ).toBe("code=NOT_FOUND status=404");
  });

  it("trims a padded request ID", () => {
    expect(fatalErrorDiagnostics(trpcError({ requestId: "  req-1  " }))).toBe("request_id=req-1");
  });

  it("survives data whose getters throw", () => {
    const data = {
      code: "NOT_FOUND",
      get requestId(): string {
        throw new Error("hostile getter");
      },
    };
    expect(fatalErrorDiagnostics(trpcError(data))).toBe("code=NOT_FOUND");
  });
});
