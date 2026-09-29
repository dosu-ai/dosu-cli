import { beforeEach, describe, expect, it, vi } from "vitest";

const mockLoadConfig = vi.fn();
vi.mock("../config/config", () => ({
  loadConfig: (...args: unknown[]) => mockLoadConfig(...args),
}));

import { CommandError } from "../cli/command-error";
import { makeTestConfig } from "../config/config.test-utils";
import { requireAPIKey, requireLoginConfig, requireOrgConfig } from "./auth";

const signedIn = {
  access_token: "t",
  refresh_token: "r",
  expires_at: 0,
  org_id: "org-1",
  api_key: "key-1",
};

beforeEach(() => {
  mockLoadConfig.mockReset();
});

function thrownBy(fn: () => unknown): unknown {
  try {
    fn();
  } catch (err) {
    return err;
  }
  return undefined;
}

describe("auth prerequisites", () => {
  it("return the config, org, and API key when all are present", () => {
    const cfg = makeTestConfig(signedIn);
    mockLoadConfig.mockReturnValue(cfg);

    expect(requireLoginConfig()).toBe(cfg);
    expect(requireOrgConfig()).toEqual({ cfg, orgId: "org-1" });
    expect(requireAPIKey(cfg)).toBe("key-1");
  });

  it.each([
    [
      "NOT_LOGGED_IN",
      "Not logged in. Run 'dosu login' first.",
      () => {
        mockLoadConfig.mockReturnValue({ schema_version: 2 });
        return requireLoginConfig();
      },
    ],
    [
      "NO_ORG_SELECTED",
      "Missing org config. Run 'dosu setup' to reconfigure.",
      () => {
        mockLoadConfig.mockReturnValue(makeTestConfig({ ...signedIn, org_id: undefined }));
        return requireOrgConfig();
      },
    ],
    [
      "NO_API_KEY",
      "API key not configured. Run 'dosu setup' first.",
      () => requireAPIKey(makeTestConfig({ ...signedIn, api_key: undefined })),
    ],
  ])("throw a %s CommandError instead of exiting", (code, message, call) => {
    const exit = vi.spyOn(process, "exit");

    const error = thrownBy(call);

    expect(error).toBeInstanceOf(CommandError);
    expect(error).toMatchObject({ code, message, exitCode: 1 });
    expect(exit).not.toHaveBeenCalled();
    exit.mockRestore();
  });
});
