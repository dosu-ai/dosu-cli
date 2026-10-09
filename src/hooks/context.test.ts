import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  CONTEXT_EVENT,
  disableClaudeContextHook,
  enableClaudeContextHook,
  hasClaudeContextHook,
} from "./context";
import { addGroupedHook, HOOK_COMMAND } from "./formats";

let dir: string;
const saved = process.env.CLAUDE_CONFIG_DIR;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "claude-cfg-"));
  process.env.CLAUDE_CONFIG_DIR = dir;
  delete process.env.DOSU_DEV;
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
  if (saved === undefined) delete process.env.CLAUDE_CONFIG_DIR;
  else process.env.CLAUDE_CONFIG_DIR = saved;
});

const settings = () => JSON.parse(readFileSync(join(dir, "settings.json"), "utf-8"));

describe("the Claude Code context hook", () => {
  it("installs on UserPromptSubmit", () => {
    expect(enableClaudeContextHook()).toBe(true);
    expect(settings().hooks[CONTEXT_EVENT]).toEqual([
      { hooks: [{ type: "command", command: "dosu knowledge context" }] },
    ]);
  });

  it("guards Dosu's memory tools on PreToolUse with the same command, and removes both", () => {
    enableClaudeContextHook();
    enableClaudeContextHook(); // idempotent
    expect(settings().hooks.PreToolUse).toEqual([
      {
        matcher: "mcp__dosu__(search_memory|get_memory_evidence)",
        hooks: [{ type: "command", command: "dosu knowledge context" }],
      },
    ]);
    expect(hasClaudeContextHook()).toBe(true);

    disableClaudeContextHook();
    expect(settings().hooks).toEqual({});
  });

  it("reports the hook missing when either half is gone", () => {
    enableClaudeContextHook();
    const config = settings();
    delete config.hooks.PreToolUse;
    writeFileSync(join(dir, "settings.json"), JSON.stringify(config));
    expect(hasClaudeContextHook()).toBe(false);
  });

  it("lives beside the sync hook without touching it", () => {
    // Both are Dosu hooks in one settings file; each must be recognized by its own matcher, or
    // enabling one would rewrite the other's command in place.
    writeFileSync(join(dir, "settings.json"), JSON.stringify(addGroupedHook({}, "SessionEnd")));
    enableClaudeContextHook();
    enableClaudeContextHook(); // idempotent
    const hooks = settings().hooks;
    expect(hooks.SessionEnd[0].hooks[0].command).toBe(HOOK_COMMAND);
    expect(hooks[CONTEXT_EVENT]).toHaveLength(1);

    disableClaudeContextHook();
    const after = settings().hooks;
    expect(after[CONTEXT_EVENT]).toBeUndefined();
    expect(after.SessionEnd[0].hooks[0].command).toBe(HOOK_COMMAND);
  });

  it("keeps the user's own prompt hooks", () => {
    const mine = { hooks: [{ type: "command", command: "my-linter --prompt" }] };
    writeFileSync(
      join(dir, "settings.json"),
      JSON.stringify({ hooks: { [CONTEXT_EVENT]: [mine] } }),
    );
    enableClaudeContextHook();
    disableClaudeContextHook();
    expect(settings().hooks[CONTEXT_EVENT]).toEqual([mine]);
  });

  it("does nothing when Claude Code is not installed", () => {
    process.env.CLAUDE_CONFIG_DIR = join(dir, "nope");
    vi.stubEnv("PATH", join(dir, "empty-bin"));
    try {
      expect(enableClaudeContextHook()).toBe(false);
    } finally {
      vi.unstubAllEnvs();
    }
  });
});
