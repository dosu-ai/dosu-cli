import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { codexHooksPath, inspectCodexHooks, installCodexHooks, removeCodexHooks } from "./codex";

describe("codex hooks installer", () => {
  let tempDir: string;
  let configPath: string;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), "dosu-codex-test-"));
    configPath = codexHooksPath(tempDir);
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  function readConfig(): Record<string, unknown> {
    // biome-ignore lint/suspicious/noExplicitAny: test helper over untyped JSON
    return JSON.parse(readFileSync(configPath, "utf-8")) as Record<string, any>;
  }

  it("codexHooksPath points at the project .codex/hooks.json", () => {
    expect(codexHooksPath("/some/project")).toBe(join("/some/project", ".codex", "hooks.json"));
  });

  it("fresh install writes all three events with the exact Codex hook shape", () => {
    const { events } = installCodexHooks(configPath);
    expect(events).toEqual(["UserPromptSubmit", "PostToolUse", "Stop"]);

    // biome-ignore lint/suspicious/noExplicitAny: asserting raw JSON shape
    const cfg = readConfig() as any;
    for (const event of events) {
      expect(cfg.hooks[event]).toHaveLength(1);
      const group = cfg.hooks[event][0];
      // Codex parsers may reject unknown fields, and any extra key would
      // change the hook's trust hash — the group must contain ONLY the
      // documented fields (no matcher, no __dosu-style marker).
      expect(Object.keys(group).sort()).toEqual(["hooks"]);
      expect(group.hooks).toHaveLength(1);
      expect(Object.keys(group.hooks[0]).sort()).toEqual([
        "command",
        "statusMessage",
        "timeout",
        "type",
      ]);
      expect(group.hooks[0].type).toBe("command");
      expect(group.hooks[0].command).toMatch(/^dosu hooks [a-z-]+ --agent codex$/);
      expect(group.hooks[0].timeout).toBeGreaterThan(0);
    }
    expect(cfg.hooks.UserPromptSubmit[0].hooks[0].command).toBe(
      "dosu hooks user-prompt-submit --agent codex",
    );
    expect(cfg.hooks.Stop[0].hooks[0].timeout).toBe(30);
  });

  it("--no-stop installs only UserPromptSubmit + PostToolUse", () => {
    const { events } = installCodexHooks(configPath, { stop: false });
    expect(events).toEqual(["UserPromptSubmit", "PostToolUse"]);
    // biome-ignore lint/suspicious/noExplicitAny: asserting raw JSON shape
    const cfg = readConfig() as any;
    expect(cfg.hooks.Stop).toBeUndefined();
  });

  it("reinstall is idempotent (no duplicate Dosu groups)", () => {
    installCodexHooks(configPath);
    installCodexHooks(configPath);
    // biome-ignore lint/suspicious/noExplicitAny: asserting raw JSON shape
    const cfg = readConfig() as any;
    expect(cfg.hooks.UserPromptSubmit).toHaveLength(1);
    expect(cfg.hooks.Stop).toHaveLength(1);
  });

  it("reinstall with --no-stop sweeps the previously installed Dosu Stop group", () => {
    installCodexHooks(configPath);
    installCodexHooks(configPath, { stop: false });
    // biome-ignore lint/suspicious/noExplicitAny: asserting raw JSON shape
    const cfg = readConfig() as any;
    expect(cfg.hooks.Stop).toBeUndefined();
    expect(cfg.hooks.UserPromptSubmit).toHaveLength(1);
  });

  it("preserves the user's own hooks and unknown top-level keys", () => {
    mkdirSync(dirname(configPath), { recursive: true });
    const userGroup = {
      matcher: "Bash",
      hooks: [{ type: "command", command: "python3 my-hook.py" }],
    };
    writeFileSync(
      configPath,
      JSON.stringify({ somethingElse: { keep: true }, hooks: { PostToolUse: [userGroup] } }),
    );

    installCodexHooks(configPath);
    removeCodexHooks(configPath);

    // biome-ignore lint/suspicious/noExplicitAny: asserting raw JSON shape
    const cfg = readConfig() as any;
    expect(cfg.somethingElse).toEqual({ keep: true });
    expect(cfg.hooks.PostToolUse).toEqual([userGroup]);
  });

  it("refuses to modify a file with invalid JSON", () => {
    mkdirSync(dirname(configPath), { recursive: true });
    writeFileSync(configPath, "NOT JSON {{{");
    expect(() => installCodexHooks(configPath)).toThrow(/refusing to modify/);
    expect(readFileSync(configPath, "utf-8")).toBe("NOT JSON {{{");
  });

  it("remove returns false when nothing is installed", () => {
    expect(removeCodexHooks(configPath)).toEqual({ removed: false });
    mkdirSync(dirname(configPath), { recursive: true });
    writeFileSync(configPath, JSON.stringify({ hooks: {} }));
    expect(removeCodexHooks(configPath)).toEqual({ removed: false });
  });

  it("remove deletes only Dosu groups and drops empty event arrays", () => {
    installCodexHooks(configPath);
    const { removed } = removeCodexHooks(configPath);
    expect(removed).toBe(true);
    // biome-ignore lint/suspicious/noExplicitAny: asserting raw JSON shape
    const cfg = readConfig() as any;
    expect(cfg.hooks.UserPromptSubmit).toBeUndefined();
    expect(cfg.hooks.Stop).toBeUndefined();
  });

  it("remove leaves an invalid-JSON file untouched", () => {
    mkdirSync(dirname(configPath), { recursive: true });
    writeFileSync(configPath, "NOT JSON {{{");
    expect(removeCodexHooks(configPath)).toEqual({ removed: false });
    expect(readFileSync(configPath, "utf-8")).toBe("NOT JSON {{{");
  });

  it("inspect reports missing file, parse errors, and installed events", () => {
    expect(inspectCodexHooks(configPath)).toEqual({ fileExists: false, events: [] });

    installCodexHooks(configPath, { stop: false });
    expect(inspectCodexHooks(configPath)).toEqual({
      fileExists: true,
      events: ["UserPromptSubmit", "PostToolUse"],
    });

    writeFileSync(configPath, "NOT JSON {{{");
    expect(inspectCodexHooks(configPath)).toEqual({
      fileExists: true,
      parseError: true,
      events: [],
    });
  });

  it("inspect does not count user-only events as installed", () => {
    mkdirSync(dirname(configPath), { recursive: true });
    writeFileSync(
      configPath,
      JSON.stringify({
        hooks: { Stop: [{ hooks: [{ type: "command", command: "python3 mine.py" }] }] },
      }),
    );
    expect(inspectCodexHooks(configPath)).toEqual({ fileExists: true, events: [] });
    expect(existsSync(configPath)).toBe(true);
  });
});
