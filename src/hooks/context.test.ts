import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { CONTEXT_EVENT, disableClaudeContextHook, enableClaudeContextHook } from "./context";
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
    expect(enableClaudeContextHook()).toBe(false);
  });
});
