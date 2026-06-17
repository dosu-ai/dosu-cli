import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  factoryHooksPath,
  inspectFactoryHooks,
  installFactoryHooks,
  removeFactoryHooks,
} from "./factory";

describe("factory hooks installer", () => {
  let tempDir: string;
  let configPath: string;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), "dosu-factory-test-"));
    configPath = factoryHooksPath(tempDir);
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  function readConfig(): Record<string, unknown> {
    // biome-ignore lint/suspicious/noExplicitAny: test helper over untyped JSON
    return JSON.parse(readFileSync(configPath, "utf-8")) as Record<string, any>;
  }

  it("factoryHooksPath points at the project .factory/hooks.json", () => {
    expect(factoryHooksPath("/some/project")).toBe(join("/some/project", ".factory", "hooks.json"));
  });

  it("fresh install writes all three events with the correct Factory hook shape", () => {
    const { events } = installFactoryHooks(configPath);
    expect(events).toEqual(["UserPromptSubmit", "PostToolUse", "Stop"]);

    // biome-ignore lint/suspicious/noExplicitAny: asserting raw JSON shape
    const cfg = readConfig() as any;
    for (const event of events) {
      expect(cfg.hooks[event]).toHaveLength(1);
      const group = cfg.hooks[event][0];
      // No __dosu marker — Factory parsers may reject unknown keys.
      expect(group.hooks).toHaveLength(1);
      expect(group.hooks[0].type).toBe("command");
      expect(group.hooks[0].command).toMatch(/^dosu hooks [a-z-]+ --agent factory$/);
    }
    expect(cfg.hooks.UserPromptSubmit[0].hooks[0].command).toBe(
      "dosu hooks user-prompt-submit --agent factory",
    );
    expect(cfg.hooks.PostToolUse[0].matcher).toBe("*");
    // PostToolUse group has matcher + hooks only
    expect(Object.keys(cfg.hooks.PostToolUse[0]).sort()).toEqual(["hooks", "matcher"]);
    // UserPromptSubmit and Stop groups have hooks only (no matcher)
    expect(Object.keys(cfg.hooks.UserPromptSubmit[0]).sort()).toEqual(["hooks"]);
    expect(Object.keys(cfg.hooks.Stop[0]).sort()).toEqual(["hooks"]);
  });

  it("--no-stop installs only UserPromptSubmit + PostToolUse", () => {
    const { events } = installFactoryHooks(configPath, { stop: false });
    expect(events).toEqual(["UserPromptSubmit", "PostToolUse"]);
    // biome-ignore lint/suspicious/noExplicitAny: asserting raw JSON shape
    const cfg = readConfig() as any;
    expect(cfg.hooks.Stop).toBeUndefined();
  });

  it("reinstall is idempotent (no duplicate Dosu groups)", () => {
    installFactoryHooks(configPath);
    installFactoryHooks(configPath);
    // biome-ignore lint/suspicious/noExplicitAny: asserting raw JSON shape
    const cfg = readConfig() as any;
    expect(cfg.hooks.UserPromptSubmit).toHaveLength(1);
    expect(cfg.hooks.Stop).toHaveLength(1);
  });

  it("reinstall with --no-stop sweeps the previously installed Dosu Stop group", () => {
    installFactoryHooks(configPath);
    installFactoryHooks(configPath, { stop: false });
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

    installFactoryHooks(configPath);
    removeFactoryHooks(configPath);

    // biome-ignore lint/suspicious/noExplicitAny: asserting raw JSON shape
    const cfg = readConfig() as any;
    expect(cfg.somethingElse).toEqual({ keep: true });
    expect(cfg.hooks.PostToolUse).toEqual([userGroup]);
  });

  it("refuses to modify a file with invalid JSON", () => {
    mkdirSync(dirname(configPath), { recursive: true });
    writeFileSync(configPath, "NOT JSON {{{");
    expect(() => installFactoryHooks(configPath)).toThrow(/refusing to modify/);
    expect(readFileSync(configPath, "utf-8")).toBe("NOT JSON {{{");
  });

  it("remove returns false when nothing is installed", () => {
    expect(removeFactoryHooks(configPath)).toEqual({ removed: false });
    mkdirSync(dirname(configPath), { recursive: true });
    writeFileSync(configPath, JSON.stringify({ hooks: {} }));
    expect(removeFactoryHooks(configPath)).toEqual({ removed: false });
  });

  it("remove deletes only Dosu groups and drops empty event arrays", () => {
    installFactoryHooks(configPath);
    const { removed } = removeFactoryHooks(configPath);
    expect(removed).toBe(true);
    // biome-ignore lint/suspicious/noExplicitAny: asserting raw JSON shape
    const cfg = readConfig() as any;
    expect(cfg.hooks.UserPromptSubmit).toBeUndefined();
    expect(cfg.hooks.Stop).toBeUndefined();
  });

  it("remove leaves an invalid-JSON file untouched", () => {
    mkdirSync(dirname(configPath), { recursive: true });
    writeFileSync(configPath, "NOT JSON {{{");
    expect(removeFactoryHooks(configPath)).toEqual({ removed: false });
    expect(readFileSync(configPath, "utf-8")).toBe("NOT JSON {{{");
  });

  it("inspect reports missing file, parse errors, and installed events", () => {
    expect(inspectFactoryHooks(configPath)).toEqual({ fileExists: false, events: [] });

    installFactoryHooks(configPath, { stop: false });
    expect(inspectFactoryHooks(configPath)).toEqual({
      fileExists: true,
      events: ["UserPromptSubmit", "PostToolUse"],
    });

    writeFileSync(configPath, "NOT JSON {{{");
    expect(inspectFactoryHooks(configPath)).toEqual({
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
    expect(inspectFactoryHooks(configPath)).toEqual({ fileExists: true, events: [] });
    expect(existsSync(configPath)).toBe(true);
  });
});
