import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { detectSettingsConflicts, managedSettingsPaths } from "./conflicts";

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "dosu-conflicts-test-"));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

function settingsFile(name: string, contents: unknown): string {
  const path = join(dir, name);
  writeFileSync(path, typeof contents === "string" ? contents : JSON.stringify(contents));
  return path;
}

describe("managedSettingsPaths", () => {
  it("returns the documented path per platform", () => {
    expect(managedSettingsPaths("darwin")[0]).toContain("Library/Application Support");
    expect(managedSettingsPaths("linux")[0]).toBe("/etc/claude-code/managed-settings.json");
    expect(managedSettingsPaths("win32")[0]).toContain("ProgramData");
  });
});

describe("detectSettingsConflicts", () => {
  it("returns no conflicts when the managed file does not exist", () => {
    expect(detectSettingsConflicts([join(dir, "absent.json")])).toEqual([]);
  });

  it("returns no conflicts for harmless managed settings", () => {
    const file = settingsFile("managed.json", {
      permissions: { defaultMode: "acceptEdits" },
      env: { EDITOR: "vim" },
    });

    expect(detectSettingsConflicts([file])).toEqual([]);
  });

  it("flags apiKeyHelper and auth-forcing keys", () => {
    const file = settingsFile("managed.json", {
      apiKeyHelper: "/usr/local/bin/corp-key.sh",
      forceLoginMethod: "console",
    });

    expect(detectSettingsConflicts([file])).toEqual([
      { file, keys: ["apiKeyHelper", "forceLoginMethod"] },
    ]);
  });

  it("flags provider env overrides inside managed env", () => {
    const file = settingsFile("managed.json", {
      env: { ANTHROPIC_BASE_URL: "https://corp-proxy.internal", PATH: "/bin" },
    });

    expect(detectSettingsConflicts([file])).toEqual([{ file, keys: ["env.ANTHROPIC_BASE_URL"] }]);
  });

  it("treats unparsable managed settings as a conflict (fail closed)", () => {
    const file = settingsFile("managed.json", "{not json");

    expect(detectSettingsConflicts([file])).toEqual([
      { file, keys: ["<unreadable or invalid JSON>"] },
    ]);
  });

  it("ignores a managed file whose JSON is not an object", () => {
    const file = settingsFile("managed.json", "[1,2,3]");

    expect(detectSettingsConflicts([file])).toEqual([]);
  });
});
