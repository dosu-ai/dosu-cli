import { mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { loadJSONConfig } from "../mcp/config-helpers";
import {
  claudeLocalSettingsPath,
  hookCommand,
  inspectClaudeHooks,
  installClaudeHooks,
  isDosuGroup,
  removeClaudeHooks,
} from "./claude-code";

describe("hooks/claude-code installer", () => {
  let tempDir: string;
  let configPath: string;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), "dosu-cc-hooks-test-"));
    configPath = claudeLocalSettingsPath(tempDir);
  });
  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  it("derives the local settings path and the dosu hook command", () => {
    expect(configPath).toBe(join(tempDir, ".claude", "settings.local.json"));
    expect(hookCommand("post-tool-use")).toBe("dosu hooks post-tool-use");
  });

  it("installs UserPromptSubmit + PostToolUse with a marker, dosu command, and 0o600 perms", () => {
    const { events } = installClaudeHooks(configPath);
    expect(events).toEqual(["UserPromptSubmit", "PostToolUse"]);
    expect(statSync(configPath).mode & 0o777).toBe(0o600);

    const cfg = loadJSONConfig(configPath);
    const post = cfg.hooks.PostToolUse[0];
    expect(post.matcher).toBe("*");
    expect(post.hooks[0].command).toBe("dosu hooks post-tool-use");
    expect(post.hooks[0].__dosu).toBe(true);
    // UserPromptSubmit groups omit the matcher.
    expect(cfg.hooks.UserPromptSubmit[0].matcher).toBeUndefined();
    expect(cfg.hooks.Stop).toBeUndefined();
  });

  it("--with-stop additionally installs a Stop group", () => {
    const { events } = installClaudeHooks(configPath, { withStop: true });
    expect(events).toContain("Stop");
    expect(loadJSONConfig(configPath).hooks.Stop[0].hooks[0].__dosu).toBe(true);
  });

  it("preserves existing user hooks and sibling settings when merging", () => {
    mkdirSync(join(tempDir, ".claude"), { recursive: true });
    writeFileSync(
      configPath,
      JSON.stringify({
        model: "opus",
        hooks: {
          PostToolUse: [{ matcher: "Bash", hooks: [{ type: "command", command: "echo hi" }] }],
        },
      }),
    );
    installClaudeHooks(configPath);
    const cfg = loadJSONConfig(configPath);
    expect(cfg.model).toBe("opus"); // sibling preserved
    expect(cfg.hooks.PostToolUse).toHaveLength(2); // user group + dosu group
    expect(cfg.hooks.PostToolUse[0].hooks[0].command).toBe("echo hi");
  });

  it("is idempotent on reinstall (no duplicate Dosu group)", () => {
    installClaudeHooks(configPath);
    installClaudeHooks(configPath);
    const cfg = loadJSONConfig(configPath);
    expect(cfg.hooks.PostToolUse).toHaveLength(1);
    expect(cfg.hooks.PostToolUse[0].hooks[0].command).toBe("dosu hooks post-tool-use");
  });

  it("refuses to clobber a file that exists but is not valid JSON", () => {
    mkdirSync(join(tempDir, ".claude"), { recursive: true });
    writeFileSync(configPath, "{ not json");
    expect(() => installClaudeHooks(configPath)).toThrow(/not valid JSON/);
    expect(readFileSync(configPath, "utf-8")).toBe("{ not json"); // untouched
  });

  it("uninstall removes only Dosu groups and cleans empty keys", () => {
    mkdirSync(join(tempDir, ".claude"), { recursive: true });
    writeFileSync(
      configPath,
      JSON.stringify({
        hooks: {
          PostToolUse: [{ matcher: "Bash", hooks: [{ type: "command", command: "echo hi" }] }],
        },
      }),
    );
    installClaudeHooks(configPath, { withStop: true });
    const { removed } = removeClaudeHooks(configPath);
    expect(removed).toBe(true);
    const cfg = loadJSONConfig(configPath);
    expect(cfg.hooks.PostToolUse).toHaveLength(1); // user group survives
    expect(cfg.hooks.PostToolUse[0].hooks[0].command).toBe("echo hi");
    expect(cfg.hooks.UserPromptSubmit).toBeUndefined(); // emptied → key deleted
    expect(cfg.hooks.Stop).toBeUndefined();
  });

  it("uninstall deletes the whole hooks object when Dosu was the only consumer", () => {
    installClaudeHooks(configPath);
    removeClaudeHooks(configPath);
    expect(loadJSONConfig(configPath).hooks).toBeUndefined();
  });

  it("uninstall is a no-op on a missing file and never clobbers an unparseable one", () => {
    expect(removeClaudeHooks(configPath).removed).toBe(false);
    mkdirSync(join(tempDir, ".claude"), { recursive: true });
    writeFileSync(configPath, "{ broken");
    expect(removeClaudeHooks(configPath).removed).toBe(false);
    expect(readFileSync(configPath, "utf-8")).toBe("{ broken");
  });

  it("isDosuGroup matches the marker and command-shape fallback, rejects others", () => {
    expect(isDosuGroup({ hooks: [{ type: "command", command: "x", __dosu: true }] })).toBe(true);
    // both the new bare-dosu form and the legacy npx form match by command shape
    expect(isDosuGroup({ hooks: [{ type: "command", command: "dosu hooks stop" }] })).toBe(true);
    expect(
      isDosuGroup({ hooks: [{ type: "command", command: "npx -y @dosu/cli@1 hooks stop" }] }),
    ).toBe(true);
    expect(isDosuGroup({ hooks: [{ type: "command", command: "echo hi" }] })).toBe(false);
    expect(isDosuGroup(null)).toBe(false);
    expect(isDosuGroup({ hooks: "nope" })).toBe(false);
  });

  it("inspectClaudeHooks reports presence, parse errors, and installed events", () => {
    expect(inspectClaudeHooks(configPath)).toEqual({
      fileExists: false,
      parseError: false,
      events: [],
    });
    installClaudeHooks(configPath);
    expect(inspectClaudeHooks(configPath)).toEqual({
      fileExists: true,
      parseError: false,
      events: ["UserPromptSubmit", "PostToolUse"],
    });
    writeFileSync(configPath, "{ broken");
    expect(inspectClaudeHooks(configPath)).toEqual({
      fileExists: true,
      parseError: true,
      events: [],
    });
  });
});
