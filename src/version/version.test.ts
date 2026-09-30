import { describe, expect, it } from "vitest";
import { getVersionString, INSTALL_CHANNEL, isNpxInvocation, releaseTag, VERSION } from "./version";

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

  it("keeps a prerelease install on its own npm dist-tag", () => {
    expect(releaseTag("0.63.0-beta.1")).toBe("beta");
    expect(releaseTag("0.63.0-beta.12")).toBe("beta");
    expect(releaseTag("0.11.0-alpha.3")).toBe("alpha");
    expect(releaseTag("0.62.1")).toBe("latest");
    // Only the channels release.config.js publishes; anything else follows latest.
    expect(releaseTag("1.0.0-rc.1")).toBe("latest");
    expect(releaseTag("dev")).toBe("latest");
  });
});
