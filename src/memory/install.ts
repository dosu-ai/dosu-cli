/** Agent-memory hooks in Claude Code's settings.json (under `CLAUDE_CONFIG_DIR` when set) and in
 * Codex's hooks.json (under `CODEX_HOME` when set). One command, `dosu memory hook` (with
 * `--agent codex` for Codex), serves every event and dispatches on the payload's
 * `hook_event_name`. Separate from the knowledge-sync hook in the same files: neither install
 * touches the other. */

import { join } from "node:path";
import { claudeConfigDir, codexHome } from "../hooks/agents";
import {
  addGroupedHook,
  devEnvAssignments,
  devSelfCommand,
  hasGroupedHook,
  readHookConfig,
  removeGroupedHook,
  writeHookConfig,
} from "../hooks/formats";
import type { MemoryAgent } from "./state";

const HOOK_COMMAND = "dosu memory hook";

interface MemoryHook {
  event: string;
  timeout?: number;
  async?: boolean;
  /** Codex's background prompt hook, which runs stage two (`--stage-two`). */
  stageTwo?: boolean;
}

/** UserPromptSubmit waits for the recall (in single mode the note is written on the spot); 120 s
 * keeps a slow write from being cut off by Claude Code's 30 s default, which would block the
 * prompt. PostToolBatch runs once per batch of tool calls, failed ones included, right before the
 * next model request, and only reads local files; 5 s bounds a stall. The others return
 * immediately. */
const CLAUDE_CODE_HOOKS: readonly MemoryHook[] = [
  { event: "SessionStart" },
  { event: "UserPromptSubmit", timeout: 120 },
  { event: "PostToolBatch", timeout: 5 },
  { event: "Stop" },
  { event: "SessionEnd" },
];

/** Codex has no PostToolBatch, but it runs `async` hooks in the background and hands their output
 * to the next model request of the turn: a second prompt hook waits there for stage two, up to
 * the poller's 125 s deadline plus one request. SessionEnd gets Codex's maximum of 3 s instead of
 * its 1 s default, so a slow start still spawns the flush. */
const CODEX_HOOKS: readonly MemoryHook[] = [
  { event: "SessionStart" },
  { event: "UserPromptSubmit", timeout: 120 },
  { event: "UserPromptSubmit", timeout: 140, async: true, stageTwo: true },
  { event: "Stop" },
  { event: "SessionEnd", timeout: 3 },
];

interface AgentHooks {
  name: string;
  configPath: () => string;
  hooks: readonly MemoryHook[];
  /** Shown after enabling. */
  enableNote?: string;
}

const AGENT_HOOKS: Record<MemoryAgent, AgentHooks> = {
  "claude-code": {
    name: "Claude Code",
    configPath: () => join(claudeConfigDir(), "settings.json"),
    hooks: CLAUDE_CODE_HOOKS,
  },
  codex: {
    name: "Codex",
    configPath: () => join(codexHome(), "hooks.json"),
    hooks: CODEX_HOOKS,
    enableNote: "Codex skips new hooks until you trust them: open /hooks in Codex and trust them.",
  },
};

/** Dev installs pin this working copy with its endpoints inline, as the knowledge hook does. */
function memoryHookCommand(agent: MemoryAgent, hook: MemoryHook): string {
  const base =
    process.env.DOSU_DEV === "true"
      ? `${devEnvAssignments().join(" ")} ${devSelfCommand()} memory hook`
      : HOOK_COMMAND;
  return [
    base,
    ...(agent === "codex" ? ["--agent codex"] : []),
    ...(hook.stageTwo ? ["--stage-two"] : []),
  ].join(" ");
}

/** Ours in either form: `dosu memory hook`, or a dev command ending in `'<entry>' memory hook`,
 * with the flags `memoryHookCommand` adds. */
export function isMemoryHookCommand(command: unknown): boolean {
  return (
    typeof command === "string" &&
    /(?:\bdosu|')\s+memory hook(?:\s+--agent codex)?(?:\s+--stage-two)?\s*$/.test(command)
  );
}

/** Each of an agent's hooks owns its own entry: Codex has two in UserPromptSubmit. */
function ownedBy(hook: MemoryHook): (command: unknown) => boolean {
  return (command) =>
    isMemoryHookCommand(command) &&
    (command as string).trimEnd().endsWith("--stage-two") === Boolean(hook.stageTwo);
}

function hookLabel(hook: MemoryHook): string {
  return hook.stageTwo ? `${hook.event} (stage two)` : hook.event;
}

/** The agent's display name, its hooks file, and what to tell the user after enabling. */
export function memoryHooksTarget(agent: MemoryAgent): {
  name: string;
  configPath: string;
  enableNote?: string;
} {
  const { name, configPath, enableNote } = AGENT_HOOKS[agent];
  return { name, configPath: configPath(), enableNote };
}

/** Which of the agent's hooks are installed. */
export function memoryHookStatus(agent: MemoryAgent): Record<string, boolean> {
  const { configPath, hooks } = AGENT_HOOKS[agent];
  const config = readHookConfig(configPath());
  return Object.fromEntries(
    hooks.map((hook) => [hookLabel(hook), hasGroupedHook(config, hook.event, ownedBy(hook))]),
  );
}

export function enableMemoryHooks(agent: MemoryAgent): void {
  const { configPath, hooks } = AGENT_HOOKS[agent];
  const path = configPath();
  let config = readHookConfig(path);
  for (const hook of hooks) {
    config = addGroupedHook(config, hook.event, {
      command: memoryHookCommand(agent, hook),
      owns: ownedBy(hook),
      timeout: hook.timeout,
      async: hook.async,
    });
  }
  writeHookConfig(path, config);
}

export function disableMemoryHooks(agent: MemoryAgent): void {
  const { configPath, hooks } = AGENT_HOOKS[agent];
  const path = configPath();
  let config = readHookConfig(path);
  for (const hook of hooks) {
    config = removeGroupedHook(config, hook.event, ownedBy(hook));
  }
  writeHookConfig(path, config);
}
