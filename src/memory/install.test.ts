import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

let configDir: string;

vi.mock("node:os", async (importOriginal) => {
  const original = await importOriginal<typeof import("node:os")>();
  return { ...original, homedir: () => configDir };
});

import { HOOK_COMMAND } from "../hooks/formats";
import {
  disableMemoryHooks,
  enableMemoryHooks,
  isMemoryHookCommand,
  memoryHookStatus,
  memoryHooksTarget,
} from "./install";

const saved = {
  CLAUDE_CONFIG_DIR: process.env.CLAUDE_CONFIG_DIR,
  CODEX_HOME: process.env.CODEX_HOME,
  DOSU_DEV: process.env.DOSU_DEV,
};

const settings = () => JSON.parse(readFileSync(join(configDir, "settings.json"), "utf-8"));
const codexHooks = () => JSON.parse(readFileSync(join(configDir, "hooks.json"), "utf-8"));

beforeEach(() => {
  configDir = mkdtempSync(join(tmpdir(), "dosu-memory-install-"));
  process.env.CLAUDE_CONFIG_DIR = configDir;
  process.env.CODEX_HOME = configDir;
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
  it("installs the five events under CLAUDE_CONFIG_DIR, with timeouts on the prompt and tool hooks", () => {
    expect(memoryHooksTarget("claude-code").configPath).toBe(join(configDir, "settings.json"));
    enableMemoryHooks("claude-code");
    enableMemoryHooks("claude-code");

    const hook = { type: "command", command: "dosu memory hook" };
    expect(settings()).toEqual({
      hooks: {
        SessionStart: [{ hooks: [hook] }],
        UserPromptSubmit: [{ hooks: [{ ...hook, timeout: 120 }] }],
        PostToolBatch: [{ hooks: [{ ...hook, timeout: 5 }] }],
        Stop: [{ hooks: [hook] }],
        SessionEnd: [{ hooks: [hook] }],
      },
    });
    expect(memoryHookStatus("claude-code")).toEqual({
      SessionStart: true,
      UserPromptSubmit: true,
      PostToolBatch: true,
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

    enableMemoryHooks("claude-code");
    expect(settings().hooks.SessionEnd).toEqual([
      { hooks: [knowledge] },
      { hooks: [{ type: "command", command: "dosu memory hook" }] },
    ]);

    disableMemoryHooks("claude-code");
    expect(settings()).toEqual({
      model: "opus",
      hooks: { SessionEnd: [{ hooks: [knowledge] }], Stop: [own] },
    });
    expect(Object.values(memoryHookStatus("claude-code"))).toEqual([
      false,
      false,
      false,
      false,
      false,
    ]);
  });

  it("recognizes its own command in production and dev form only", () => {
    expect(isMemoryHookCommand("dosu memory hook")).toBe(true);
    expect(isMemoryHookCommand("dosu memory hook --agent codex --stage-two")).toBe(true);
    expect(isMemoryHookCommand("DOSU_DEV=true '/bin/bun' '/src/index.ts' memory hook")).toBe(true);
    expect(isMemoryHookCommand("dosu memory hook --agent cursor")).toBe(true);
    expect(isMemoryHookCommand("dosu memory hook --agent cursor --event preToolUse")).toBe(true);
    expect(isMemoryHookCommand("dosu memory hook --agent windsurf")).toBe(false);
    expect(isMemoryHookCommand(HOOK_COMMAND)).toBe(false);
    expect(isMemoryHookCommand("./my-memory hook.sh")).toBe(false);
    expect(isMemoryHookCommand(undefined)).toBe(false);
  });
});

describe("memory hooks in Codex's hooks.json", () => {
  it("installs a background stage-two prompt hook beside the knowledge hook, and removes only its own", () => {
    const knowledge = { type: "command", command: HOOK_COMMAND };
    writeFileSync(
      join(configDir, "hooks.json"),
      JSON.stringify({ hooks: { Stop: [{ hooks: [knowledge] }] } }),
    );
    enableMemoryHooks("codex");
    enableMemoryHooks("codex");

    const hook = { type: "command", command: "dosu memory hook --agent codex" };
    expect(codexHooks()).toEqual({
      hooks: {
        SessionStart: [{ hooks: [hook] }],
        UserPromptSubmit: [
          { hooks: [{ ...hook, timeout: 120 }] },
          {
            hooks: [
              {
                type: "command",
                command: "dosu memory hook --agent codex --stage-two",
                timeout: 140,
                async: true,
              },
            ],
          },
        ],
        Stop: [{ hooks: [knowledge] }, { hooks: [hook] }],
        SessionEnd: [{ hooks: [{ ...hook, timeout: 3 }] }],
      },
    });
    expect(memoryHookStatus("codex")).toEqual({
      SessionStart: true,
      UserPromptSubmit: true,
      "UserPromptSubmit (stage two)": true,
      Stop: true,
      SessionEnd: true,
    });
    expect(memoryHookStatus("claude-code").SessionStart).toBe(false);

    expect(disableMemoryHooks("codex")).toBe(0);
    expect(codexHooks()).toEqual({ hooks: { Stop: [{ hooks: [knowledge] }] } });
  });

  it("disables without moving the hooks after ours, since Codex trusts hooks by position", () => {
    enableMemoryHooks("codex");
    const own = { type: "command", command: "./audit.sh" };
    const config = codexHooks();
    config.hooks.UserPromptSubmit.push({ hooks: [own] });
    config.hooks.Stop.push({ hooks: [{ type: "command", command: HOOK_COMMAND }] });
    // One of ours moved by hand into a group ahead of a user's hook.
    config.hooks.SessionEnd = [{ hooks: [...config.hooks.SessionEnd[0].hooks, own] }];
    writeFileSync(join(configDir, "hooks.json"), JSON.stringify(config));

    expect(disableMemoryHooks("codex")).toBe(1);
    expect(codexHooks()).toEqual({
      hooks: {
        UserPromptSubmit: [{ hooks: [] }, { hooks: [] }, { hooks: [own] }],
        Stop: [{ hooks: [] }, { hooks: [{ type: "command", command: HOOK_COMMAND }] }],
        SessionEnd: [{ hooks: [own] }],
      },
    });
  });
});

describe("memory hooks in Cursor's hooks.json", () => {
  it("lists every event flat beside the knowledge hook, and removes only its own", () => {
    const cursorHooks = join(configDir, ".cursor", "hooks.json");
    const knowledge = { command: HOOK_COMMAND };
    mkdirSync(join(configDir, ".cursor"));
    writeFileSync(cursorHooks, JSON.stringify({ version: 1, hooks: { stop: [knowledge] } }));
    expect(memoryHooksTarget("cursor").configPath).toBe(cursorHooks);
    enableMemoryHooks("cursor");
    enableMemoryHooks("cursor");

    const hook = (event: string) => ({
      command: `dosu memory hook --agent cursor --event ${event}`,
    });
    expect(JSON.parse(readFileSync(cursorHooks, "utf-8"))).toEqual({
      version: 1,
      hooks: {
        sessionStart: [hook("sessionStart")],
        beforeSubmitPrompt: [{ ...hook("beforeSubmitPrompt"), timeout: 120 }],
        preToolUse: [{ ...hook("preToolUse"), timeout: 5 }],
        postToolUse: [{ ...hook("postToolUse"), matcher: "Shell", timeout: 5 }],
        afterFileEdit: [{ ...hook("afterFileEdit"), timeout: 5 }],
        afterAgentResponse: [{ ...hook("afterAgentResponse"), timeout: 5 }],
        preCompact: [hook("preCompact")],
        stop: [knowledge, hook("stop")],
        sessionEnd: [hook("sessionEnd")],
      },
    });
    expect(Object.values(memoryHookStatus("cursor")).every(Boolean)).toBe(true);

    disableMemoryHooks("cursor");
    expect(JSON.parse(readFileSync(cursorHooks, "utf-8"))).toEqual({
      version: 1,
      hooks: { stop: [knowledge] },
    });
    expect(Object.values(memoryHookStatus("cursor")).some(Boolean)).toBe(false);
  });
});
