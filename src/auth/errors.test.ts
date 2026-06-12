import { describe, expect, it } from "vitest";
import { OAuthCallbackError } from "./errors";

describe("OAuthCallbackError", () => {
  it("includes retry guidance for bad OAuth state errors", () => {
    const err = new OAuthCallbackError("bad state", {
      errorCode: "bad_oauth_state",
      errorDescription: "OAuth state expired",
    });

    expect(err.name).toBe("OAuthCallbackError");
    expect(err.userMessage).toBe(
      "Authentication failed: OAuth state expired. Run `dosu login` again.",
    );
  });

  it("includes retry guidance when the description mentions state", () => {
    const err = new OAuthCallbackError("OAuth state is invalid");

    expect(err.userMessage).toBe(
      "Authentication failed: OAuth state is invalid. Run `dosu login` again.",
    );
  });

  it("uses the generic auth failure message for non-state errors", () => {
    const err = new OAuthCallbackError("access denied", {
      error: "access_denied",
      errorDescription: "User denied consent",
    });

    expect(err.error).toBe("access_denied");
    expect(err.userMessage).toBe("Authentication failed: User denied consent");
  });
});
