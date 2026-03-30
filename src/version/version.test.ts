import { describe, it, expect } from "vitest";
import { VERSION, COMMIT, DATE, getVersionString } from "./version";

describe("version", () => {
  it("should have default values when env vars are not set", () => {
    expect(VERSION).toBe("dev");
    expect(COMMIT).toBe("none");
    expect(DATE).toBe("unknown");
  });

  it("should return formatted version string", () => {
    const result = getVersionString();
    expect(result).toMatch(/^dosu .+ \(.+, .+\)$/);
    expect(result).toContain("dev");
  });
});
