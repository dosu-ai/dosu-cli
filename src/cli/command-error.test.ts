import { describe, expect, it } from "vitest";
import { CommandError, isCommandError } from "./command-error";

describe("CommandError", () => {
  it("carries a stable code, exit code 1, and optional detail lines", () => {
    const error = new CommandError("NOT_LOGGED_IN", "Not logged in.", ["Run 'dosu login'."]);

    expect(error).toBeInstanceOf(Error);
    expect(error.name).toBe("CommandError");
    expect(error.code).toBe("NOT_LOGGED_IN");
    expect(error.exitCode).toBe(1);
    expect(error.message).toBe("Not logged in.");
    expect(error.details).toEqual(["Run 'dosu login'."]);
    expect(new CommandError("NO_API_KEY", "x").details).toEqual([]);
  });

  it("is recognized by isCommandError only for real instances", () => {
    expect(isCommandError(new CommandError("NOT_LOGGED_IN", "x"))).toBe(true);
    expect(isCommandError(Object.assign(new Error("x"), { code: "NOT_LOGGED_IN" }))).toBe(false);
    expect(isCommandError(undefined)).toBe(false);
  });
});
