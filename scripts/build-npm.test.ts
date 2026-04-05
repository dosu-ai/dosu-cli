import { existsSync, readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { buildDefines, normalizeNodeBundle } from "./build-npm";

describe("build-npm script", () => {
  it("script file exists", () => {
    expect(existsSync("scripts/build-npm.ts")).toBe(true);
  });

  it("normalizeNodeBundle rewrites the shebang and strips bun directive", () => {
    const output = normalizeNodeBundle("#!/usr/bin/env bun\n// @bun\nconsole.log('hi')\n");
    expect(output).toBe("#!/usr/bin/env node\nconsole.log('hi')\n");
  });

  it("normalizeNodeBundle prepends a node shebang when missing", () => {
    const output = normalizeNodeBundle("console.log('hi')\n");
    expect(output).toBe("#!/usr/bin/env node\nconsole.log('hi')\n");
  });

  it("re-exports buildDefines from build-all", () => {
    // buildDefines should be the same function from build-all.ts
    const defines = buildDefines();
    expect(defines).toContain("--define");
    expect(defines.some((d) => d.startsWith("process.env.DOSU_VERSION="))).toBe(true);
  });

  it("does not use redundant --env flags", () => {
    const content = readFileSync("scripts/build-npm.ts", "utf8");
    expect(content).not.toContain("--env=");
  });
});
