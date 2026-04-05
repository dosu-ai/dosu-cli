import { describe, expect, it } from "vitest";
import { getVersionString, VERSION } from "./version";

describe("version", () => {
  it("should read version from package.json in dev mode", () => {
    // When DOSU_VERSION is not set (dev mode), falls back to package.json
    expect(VERSION).toMatch(/^\d+\.\d+\.\d+/);
  });

  it("should return clean version string", () => {
    const result = getVersionString();
    expect(result).toMatch(/^v\d+\.\d+\.\d+/);
  });
});
