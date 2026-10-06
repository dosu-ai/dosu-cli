/** Agent-memory hooks in Claude Code's settings.json (under `CLAUDE_CONFIG_DIR` when set), in
 * Codex's hooks.json (under `CODEX_HOME` when set), and in Cursor's ~/.cursor/hooks.json. One
 * command, `dosu memory hook` (with `--agent codex` or `--agent cursor`), serves every event and
 * dispatches on the payload's `hook_event_name`. Separate from the knowledge-sync hook in the same
 * files: neither install touches the other. */

import { chmodSync, existsSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { getConfigDir } from "../config/config";
import { claudeConfigDir, codexHome, cursorHooksPath } from "../hooks/agents";
import {
  addCursorHook,
  addGroupedHook,
  devEnvAssignments,
  devSelfCommand,
  HookConfigError,
  hasCursorHook,
  hasGroupedHook,
  readHookConfig,
  removeCursorHook,
  removeGroupedHook,
  removeGroupedHookInPlace,
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
 * immediately. SessionEnd gets 5 s instead of Claude Code's 1.5 s default for it: on a busy
 * machine the CLI took up to 2.6 s to start, and Claude Code cancelled the hook before it spawned
 * the flush, leaving the episode to the backend's quiet period. */
const CLAUDE_CODE_HOOKS: readonly MemoryHook[] = [
  { event: "SessionStart" },
  { event: "UserPromptSubmit", timeout: 120 },
  { event: "PostToolBatch", timeout: 5 },
  { event: "Stop" },
  { event: "SessionEnd", timeout: 5 },
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

/** Cursor's events. beforeSubmitPrompt waits for the recall and hands stage one over, as
 * UserPromptSubmit does on Claude Code. postToolUse and postToolUseFailure run after every tool
 * call, failed ones included: they hand stage two over and record shell commands (Cursor sends a
 * command that exits non-zero to the latter). They and the other recording hooks read and write
 * local files only, and 5 s bounds a stall. The others return immediately. */
const CURSOR_HOOKS: readonly MemoryHook[] = [
  { event: "sessionStart" },
  { event: "beforeSubmitPrompt", timeout: 120 },
  { event: "postToolUse", timeout: 5 },
  { event: "postToolUseFailure", timeout: 5 },
  { event: "afterFileEdit", timeout: 5 },
  { event: "afterAgentResponse", timeout: 5 },
  { event: "preCompact" },
  { event: "stop" },
  { event: "sessionEnd" },
];

interface AgentHooks {
  name: string;
  configPath: () => string;
  /** Claude Code and Codex group entries under a matcher; Cursor lists them flat. */
  format: "grouped" | "cursor";
  hooks: readonly MemoryHook[];
  /** Shown after enabling. */
  enableNote?: string;
  /** Codex trusts each hook by its position in the file: removing ours must not move others. */
  trustsByPosition?: boolean;
}

const AGENT_HOOKS: Record<MemoryAgent, AgentHooks> = {
  "claude-code": {
    name: "Claude Code",
    configPath: () => join(claudeConfigDir(), "settings.json"),
    format: "grouped",
    hooks: CLAUDE_CODE_HOOKS,
  },
  codex: {
    name: "Codex",
    configPath: () => join(codexHome(), "hooks.json"),
    format: "grouped",
    hooks: CODEX_HOOKS,
    enableNote: "Codex skips new hooks until you trust them: open /hooks in Codex and trust them.",
    trustsByPosition: true,
  },
  cursor: {
    name: "Cursor",
    configPath: cursorHooksPath,
    format: "cursor",
    hooks: CURSOR_HOOKS,
  },
};

/** Cursor reads hooks.json as JSONC and strips `//` and `/*` comments even inside strings (CLI
 * 2026.09.28), so a single command holding either breaks the whole file and every hook in it. */
const CURSOR_COMMENT = /\/\/|\/\*/;

/** A dev install's stand-in for `dosu` on Cursor. Dev commands inline their endpoints, URLs
 * included, which Cursor would read as comments; its commands call this script instead, which
 * holds them. */
function cursorDevShimPath(): string {
  return join(getConfigDir(), "cursor-dev-dosu");
}

/** Owner-only from the start: a new file is created 0700, an old one narrowed before it is
 * rewritten. */
function writeCursorDevShim(): void {
  const path = cursorDevShimPath();
  mkdirSync(dirname(path), { recursive: true });
  if (existsSync(path)) chmodSync(path, 0o700);
  const script = `${devEnvAssignments().join(" ")} ${devSelfCommand()}`;
  writeFileSync(
    path,
    `#!/bin/sh\n# \`dosu memory hooks enable --agent cursor\` in dev mode: this working copy and its endpoints.\nexec env ${script} "$@"\n`,
    { mode: 0o700 },
  );
}

/** Dev installs pin this working copy with its endpoints inline, as the knowledge hook does; on
 * Cursor, through `cursorDevShimPath`. */
function memoryHookCommand(agent: MemoryAgent, hook: MemoryHook): string {
  let base = HOOK_COMMAND;
  if (process.env.DOSU_DEV === "true") {
    base =
      agent === "cursor"
        ? `'${cursorDevShimPath()}' memory hook`
        : `${devEnvAssignments().join(" ")} ${devSelfCommand()} memory hook`;
  }
  return [
    base,
    ...(agent === "claude-code" ? [] : [`--agent ${agent}`]),
    ...(hook.stageTwo ? ["--stage-two"] : []),
  ].join(" ");
}

/** Ours in either form: `dosu memory hook`, or a dev command ending in `'<entry>' memory hook`,
 * with the flags `memoryHookCommand` adds. */
export function isMemoryHookCommand(command: unknown): boolean {
  return (
    typeof command === "string" &&
    /(?:\bdosu|')\s+memory hook(?:\s+--agent (?:codex|cursor))?(?:\s+--stage-two)?\s*$/.test(
      command,
    )
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

/** Setup provider ids (`src/mcp/providers`) of the agents agent memory supports. */
const AGENT_BY_PROVIDER = new Map<string, MemoryAgent>([
  ["claude", "claude-code"],
  ["codex", "codex"],
  ["cursor", "cursor"],
]);

/** The memory agent behind a setup provider, or null when agent memory does not support it. */
export function memoryAgentForProvider(providerID: string): MemoryAgent | null {
  return AGENT_BY_PROVIDER.get(providerID) ?? null;
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
  const { configPath, format, hooks } = AGENT_HOOKS[agent];
  const config = readHookConfig(configPath());
  const has = format === "cursor" ? hasCursorHook : hasGroupedHook;
  return Object.fromEntries(
    hooks.map((hook) => [hookLabel(hook), has(config, hook.event, ownedBy(hook))]),
  );
}

export function enableMemoryHooks(agent: MemoryAgent): void {
  const { configPath, format, hooks } = AGENT_HOOKS[agent];
  const path = configPath();
  let config = readHookConfig(path);
  if (format === "cursor") {
    const unsafe = hooks
      .map((hook) => memoryHookCommand(agent, hook))
      .find((command) => CURSOR_COMMENT.test(command));
    if (unsafe) {
      throw new HookConfigError(
        `refusing to write ${path}: Cursor reads // and /* as comments even inside a command, ` +
          `which would break every hook in the file: ${unsafe}`,
      );
    }
    if (process.env.DOSU_DEV === "true") writeCursorDevShim();
  }
  for (const hook of hooks) {
    const spec = {
      command: memoryHookCommand(agent, hook),
      owns: ownedBy(hook),
      timeout: hook.timeout,
    };
    config =
      format === "cursor"
        ? addCursorHook(config, hook.event, spec)
        : addGroupedHook(config, hook.event, { ...spec, async: hook.async });
  }
  writeHookConfig(path, config);
}

/** Returns how many of the agent's other hooks moved and so need trusting again (Codex only, and
 * only where one of ours shares a group with them). */
export function disableMemoryHooks(agent: MemoryAgent): number {
  const { configPath, format, hooks, trustsByPosition } = AGENT_HOOKS[agent];
  const path = configPath();
  let config = readHookConfig(path);
  let moved = 0;
  for (const hook of hooks) {
    if (format === "cursor") {
      config = removeCursorHook(config, hook.event, ownedBy(hook));
    } else if (trustsByPosition) {
      const removed = removeGroupedHookInPlace(config, hook.event, ownedBy(hook));
      config = removed.config;
      moved += removed.moved;
    } else {
      config = removeGroupedHook(config, hook.event, ownedBy(hook));
    }
  }
  writeHookConfig(path, config);
  return moved;
}
