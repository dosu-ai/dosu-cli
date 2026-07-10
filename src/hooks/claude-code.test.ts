import { mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { loadJSONConfig } from "../mcp/config-helpers";
import {
  claudeLocalSettingsPath,
  hookCommand,
  inspectClaudeHooks,
  installClaudeHooks,
  isDosuGroup,
  removeClaudeHooks,
} from "./claude-code";

// Pin the hook command prefix: the real resolver probes PATH and can
// materialize a bundle — nondeterministic across machines and unwanted in tests.
vi.mock("./runtime", () => ({
  resolveHookCommandPrefix: vi.fn(() => "dosu"),
}));

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

  it("installs UserPromptSubmit + PostToolUse + Stop with a marker, dosu command, and 0o600 perms", () => {
    const { events } = installClaudeHooks(configPath);
    expect(events).toEqual(["UserPromptSubmit", "PostToolUse", "Stop"]);
    expect(statSync(configPath).mode & 0o777).toBe(0o600);

    const cfg = loadJSONConfig(configPath);
    const post = cfg.hooks.PostToolUse[0];
    expect(post.matcher).toBe("*");
    expect(post.hooks[0].command).toBe("dosu hooks post-tool-use");
    expect(post.hooks[0].__dosu).toBe(true);
    // UserPromptSubmit / Stop groups omit the matcher.
    expect(cfg.hooks.UserPromptSubmit[0].matcher).toBeUndefined();
    expect(cfg.hooks.Stop[0].matcher).toBeUndefined();
    expect(cfg.hooks.Stop[0].hooks[0].__dosu).toBe(true);
  });

  it("--no-stop (stop: false) omits the Stop group", () => {
    const { events } = installClaudeHooks(configPath, { stop: false });
    expect(events).toEqual(["UserPromptSubmit", "PostToolUse"]);
    expect(loadJSONConfig(configPath).hooks.Stop).toBeUndefined();
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
    installClaudeHooks(configPath);
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
    // path-prefixed dosu still matches; a user command that merely MENTIONS
    // "dosu hooks" as an argument must NOT (else uninstall would delete it)
    expect(isDosuGroup({ hooks: [{ type: "command", command: "/usr/bin/dosu hooks stop" }] })).toBe(
      true,
    );
    expect(isDosuGroup({ hooks: [{ type: "command", command: 'echo "dosu hooks stop"' }] })).toBe(
      false,
    );
    expect(isDosuGroup({ hooks: [{ type: "command", command: "echo hi" }] })).toBe(false);
    // materialized runtime (npx-only install): node + dosu.js bundle, with or
    // without quotes/spaces, POSIX or Windows paths and separators
    expect(
      isDosuGroup({
        hooks: [
          { type: "command", command: 'node "/home/u/.config/dosu-cli/bin/dosu.js" hooks stop' },
        ],
      }),
    ).toBe(true);
    expect(
      isDosuGroup({
        hooks: [
          {
            type: "command",
            command: 'node "C:\\Users\\John Doe\\AppData\\dosu-cli\\bin\\dosu.js" hooks stop',
          },
        ],
      }),
    ).toBe(true);
    expect(
      isDosuGroup({
        hooks: [
          {
            type: "command",
            command: "C:\\nodejs\\node.exe C:\\dosu-cli\\bin\\dosu.js hooks post-tool-use",
          },
        ],
      }),
    ).toBe(true);
    // node running some OTHER script that merely mentions hooks is not ours
    expect(isDosuGroup({ hooks: [{ type: "command", command: "node build.js hooks stop" }] })).toBe(
      false,
    );
    expect(
      isDosuGroup({ hooks: [{ type: "command", command: 'echo "node dosu.js hooks stop"' }] }),
    ).toBe(false);
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
      events: ["UserPromptSubmit", "PostToolUse", "Stop"],
    });
    writeFileSync(configPath, "{ broken");
    expect(inspectClaudeHooks(configPath)).toEqual({
      fileExists: true,
      parseError: true,
      events: [],
    });
  });
});
