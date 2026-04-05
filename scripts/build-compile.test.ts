import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

describe("build-compile script", () => {
  it("script file exists", () => {
    expect(existsSync(join(__dirname, "build-compile.ts"))).toBe(true);
  });

  it("uses --compile flag for standalone binary", () => {
    const content = readFileSync(join(__dirname, "build-compile.ts"), "utf-8");
    expect(content).toContain("--compile");
  });

  it("uses --define via buildDefines from build-all", () => {
    const content = readFileSync(join(__dirname, "build-compile.ts"), "utf-8");
    expect(content).toContain('import { buildDefines } from "./build-all"');
    expect(content).toContain("...defines");
  });

  it("inlines Dosu and Supabase environment variables", () => {
    const content = readFileSync(join(__dirname, "build-compile.ts"), "utf-8");
    expect(content).toContain("--env=DOSU_*");
    expect(content).toContain("--env=SUPABASE_*");
  });
});
