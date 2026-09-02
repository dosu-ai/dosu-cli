import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { devConfigDir, resetDevState } from "./reset-dev";

let tempDir: string;

beforeEach(() => {
  tempDir = mkdtempSync(join(tmpdir(), "dosu-reset-test-"));
});

afterEach(() => {
  rmSync(tempDir, { recursive: true, force: true });
});

describe("devConfigDir", () => {
  it("resolves under XDG_CONFIG_HOME when set", () => {
    expect(devConfigDir({ XDG_CONFIG_HOME: "/tmp/xdg" } as NodeJS.ProcessEnv)).toBe(
      join("/tmp/xdg", "dosu-cli-dev"),
    );
  });

  it("falls back to ~/.config and never targets the real install's dir", () => {
    const dir = devConfigDir({} as NodeJS.ProcessEnv);
    expect(dir.endsWith(join(".config", "dosu-cli-dev"))).toBe(true);
  });
});

describe("resetDevState", () => {
  it("removes the dir and its contents", () => {
    const dir = join(tempDir, "dosu-cli-dev");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "config.json"), "{}");
    writeFileSync(join(dir, "knowledge-sync.json"), "{}");

    expect(resetDevState(dir)).toBe(true);
    expect(existsSync(dir)).toBe(false);
  });

  it("reports when there is nothing to clear", () => {
    expect(resetDevState(join(tempDir, "missing"))).toBe(false);
  });
});
