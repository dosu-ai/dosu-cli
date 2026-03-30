import { describe, it, expect } from "vitest";
import { existsSync } from "node:fs";
import { join } from "node:path";

describe("build-all script", () => {
  it("script file exists", () => {
    expect(existsSync(join(__dirname, "build-all.ts"))).toBe(true);
  });

  it("defines correct target platforms", () => {
    const { readFileSync } = require("node:fs");
    const content = readFileSync(join(__dirname, "build-all.ts"), "utf-8");
    expect(content).toContain("bun-darwin-arm64");
    expect(content).toContain("bun-darwin-x64");
    expect(content).toContain("bun-linux-x64");
    expect(content).toContain("bun-linux-arm64");
    expect(content).toContain("bun-windows-x64");
  });
});
