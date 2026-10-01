import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { HOOK_COMMAND } from "../hooks/formats";
import {
  claudeSettingsPath,
  disableMemoryHooks,
  enableMemoryHooks,
  isMemoryHookCommand,
  memoryHookStatus,
} from "./install";

let configDir: string;
const saved = { CLAUDE_CONFIG_DIR: process.env.CLAUDE_CONFIG_DIR, DOSU_DEV: process.env.DOSU_DEV };

const settings = () => JSON.parse(readFileSync(join(configDir, "settings.json"), "utf-8"));

beforeEach(() => {
  configDir = mkdtempSync(join(tmpdir(), "dosu-memory-install-"));
  process.env.CLAUDE_CONFIG_DIR = configDir;
  delete process.env.DOSU_DEV;
});

afterEach(() => {
  rmSync(configDir, { recursive: true, force: true });
  for (const [name, value] of Object.entries(saved)) {
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
});

describe("memory hooks in Claude Code settings", () => {
  it("installs the four events under CLAUDE_CONFIG_DIR, UserPromptSubmit with a 120 s timeout", () => {
    expect(claudeSettingsPath()).toBe(join(configDir, "settings.json"));
    enableMemoryHooks();
    enableMemoryHooks();

    const hook = { type: "command", command: "dosu memory hook" };
    expect(settings()).toEqual({
      hooks: {
        SessionStart: [{ hooks: [hook] }],
        UserPromptSubmit: [{ hooks: [{ ...hook, timeout: 120 }] }],
        Stop: [{ hooks: [hook] }],
        SessionEnd: [{ hooks: [hook] }],
      },
    });
    expect(memoryHookStatus()).toEqual({
      SessionStart: true,
      UserPromptSubmit: true,
      Stop: true,
      SessionEnd: true,
    });
  });

  it("leaves the knowledge-sync hook and the user's own hooks alone", () => {
    const knowledge = { type: "command", command: HOOK_COMMAND };
    const own = { matcher: "Bash", hooks: [{ type: "command", command: "./lint.sh" }] };
    writeFileSync(
      join(configDir, "settings.json"),
      JSON.stringify({
        model: "opus",
        hooks: { SessionEnd: [{ hooks: [knowledge] }], Stop: [own] },
      }),
    );

    enableMemoryHooks();
    expect(settings().hooks.SessionEnd).toEqual([
      { hooks: [knowledge] },
      { hooks: [{ type: "command", command: "dosu memory hook" }] },
    ]);

    disableMemoryHooks();
    expect(settings()).toEqual({
      model: "opus",
      hooks: { SessionEnd: [{ hooks: [knowledge] }], Stop: [own] },
    });
    expect(Object.values(memoryHookStatus())).toEqual([false, false, false, false]);
  });

  it("recognizes its own command in production and dev form only", () => {
    expect(isMemoryHookCommand("dosu memory hook")).toBe(true);
    expect(isMemoryHookCommand("DOSU_DEV=true '/bin/bun' '/src/index.ts' memory hook")).toBe(true);
    expect(isMemoryHookCommand(HOOK_COMMAND)).toBe(false);
    expect(isMemoryHookCommand("./my-memory hook.sh")).toBe(false);
    expect(isMemoryHookCommand(undefined)).toBe(false);
  });
});
