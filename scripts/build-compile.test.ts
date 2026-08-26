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

  it("disables implicit cwd dotenv and bunfig loading", () => {
    const content = readFileSync(join(__dirname, "build-compile.ts"), "utf-8");
    expect(content).toContain('"--no-compile-autoload-dotenv"');
    expect(content).toContain('"--no-compile-autoload-bunfig"');
  });

  it("uses --define via buildDefines from build-all", () => {
    const content = readFileSync(join(__dirname, "build-compile.ts"), "utf-8");
    expect(content).toContain("buildDefines");
    expect(content).toContain('from "./build-all"');
    expect(content).toContain("...defines");
  });

  it("does not use redundant --env flags", () => {
    const content = readFileSync(join(__dirname, "build-compile.ts"), "utf-8");
    expect(content).not.toContain("--env=");
  });
});
