import { describe, expect, it } from "vitest";
import { getVersionString, INSTALL_CHANNEL, isNpxInvocation, VERSION } from "./version";

describe("version", () => {
  it("should read version from package.json in dev mode", () => {
    // When DOSU_VERSION is not set (dev mode), falls back to package.json
    expect(VERSION).toMatch(/^\d+\.\d+\.\d+/);
  });

  it("should return clean version string", () => {
    const result = getVersionString();
    expect(result).toMatch(/^v\d+\.\d+\.\d+/);
  });

  it("should default INSTALL_CHANNEL to npm in dev/source mode", () => {
    expect(INSTALL_CHANNEL).toBe("npm");
  });

  it("recognizes npm exec and npx without treating other channels as npx", () => {
    expect(isNpxInvocation("npm", { npm_lifecycle_event: "npx" })).toBe(true);
    expect(isNpxInvocation("npm", { npm_command: "exec" })).toBe(true);
    expect(isNpxInvocation("npm", {})).toBe(false);
    expect(isNpxInvocation("homebrew", { npm_lifecycle_event: "npx" })).toBe(false);
  });
});
