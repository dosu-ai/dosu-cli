import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

describe("build-compile script", () => {
  it("script file exists", () => {
    expect(existsSync(join(__dirname, "build-compile.ts"))).toBe(true);
  });

  it("compiles through build-all's shared compileBinary", () => {
    const content = readFileSync(join(__dirname, "build-compile.ts"), "utf-8");
    expect(content).toContain('import { compileBinary } from "./build-all"');
    expect(content).toContain("compileBinary(OUTFILE)");
  });

  it("does not use redundant --env flags", () => {
    const content = readFileSync(join(__dirname, "build-compile.ts"), "utf-8");
    expect(content).not.toContain("--env=");
  });
});
