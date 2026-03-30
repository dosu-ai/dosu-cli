import { existsSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { buildDefines } from "./build-all";

describe("build-all script", () => {
  it("script file exists", () => {
    expect(existsSync(join(__dirname, "build-all.ts"))).toBe(true);
  });

  it("defines correct target platforms", () => {
    const { readFileSync } = require("node:fs");
    const content = readFileSync(join(__dirname, "build-all.ts"), "utf-8");
    expect(content).toContain("bun-darwin-arm64");
    expect(content).toContain("bun-darwin-x64");
    expect(content).toContain("bun-linux-x64-baseline");
    expect(content).toContain("bun-linux-arm64");
    expect(content).toContain("bun-linux-x64-musl");
    expect(content).toContain("bun-linux-arm64-musl");
    expect(content).toContain("bun-windows-x64-baseline");
  });
});

describe("buildDefines", () => {
  const envBackup: Record<string, string | undefined> = {};

  beforeEach(() => {
    envBackup.DOSU_VERSION = process.env.DOSU_VERSION;
    envBackup.DOSU_COMMIT = process.env.DOSU_COMMIT;
    envBackup.DOSU_DATE = process.env.DOSU_DATE;
    delete process.env.DOSU_VERSION;
    delete process.env.DOSU_COMMIT;
    delete process.env.DOSU_DATE;
  });

  afterEach(() => {
    for (const [key, val] of Object.entries(envBackup)) {
      if (val === undefined) delete process.env[key];
      else process.env[key] = val;
    }
  });

  it("should return dev defaults when env vars are not set", () => {
    const defines = buildDefines();
    expect(defines).toEqual([
      "--define",
      'process.env.DOSU_VERSION="dev"',
      "--define",
      'process.env.DOSU_COMMIT="none"',
      "--define",
      'process.env.DOSU_DATE="unknown"',
    ]);
  });

  it("should use env vars when set", () => {
    process.env.DOSU_VERSION = "1.2.3";
    process.env.DOSU_COMMIT = "abc1234";
    process.env.DOSU_DATE = "2026-03-30T00:00:00Z";

    const defines = buildDefines();
    expect(defines).toEqual([
      "--define",
      'process.env.DOSU_VERSION="1.2.3"',
      "--define",
      'process.env.DOSU_COMMIT="abc1234"',
      "--define",
      'process.env.DOSU_DATE="2026-03-30T00:00:00Z"',
    ]);
  });

  it("should produce valid JSON-stringified values", () => {
    process.env.DOSU_VERSION = 'has"quotes';

    const defines = buildDefines();
    // JSON.stringify escapes inner quotes
    expect(defines[1]).toBe('process.env.DOSU_VERSION="has\\"quotes"');
  });

  it("should return exactly 6 elements (3 pairs of --define + value)", () => {
    const defines = buildDefines();
    expect(defines).toHaveLength(6);
    expect(defines.filter((_, i) => i % 2 === 0)).toEqual(["--define", "--define", "--define"]);
  });
});
