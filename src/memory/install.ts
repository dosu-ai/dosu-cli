/** Agent-memory hooks in Claude Code's settings.json (under `CLAUDE_CONFIG_DIR` when set). One
 * command, `dosu memory hook`, serves every event and dispatches on the payload's
 * `hook_event_name`. Separate from the knowledge-sync hook: neither install touches the other. */

import { join } from "node:path";
import { claudeConfigDir } from "../hooks/agents";
import {
  addGroupedHook,
  devEnvAssignments,
  devSelfCommand,
  hasGroupedHook,
  readHookConfig,
  removeGroupedHook,
  writeHookConfig,
} from "../hooks/formats";

const HOOK_COMMAND = "dosu memory hook";

/** UserPromptSubmit waits for the recall (in single mode the note is written on the spot); 120 s
 * keeps a slow write from being cut off by Claude Code's 30 s default, which would block the
 * prompt. PostToolUse runs on every tool call and only reads local files; 5 s bounds a stall
 * (Claude Code then keeps the tool result and moves on). The others return immediately. */
const MEMORY_HOOK_EVENTS: ReadonlyArray<{ event: string; timeout?: number }> = [
  { event: "SessionStart" },
  { event: "UserPromptSubmit", timeout: 120 },
  { event: "PostToolUse", timeout: 5 },
  { event: "Stop" },
  { event: "SessionEnd" },
];

/** Dev installs pin this working copy with its endpoints inline, as the knowledge hook does. */
function memoryHookCommand(): string {
  if (process.env.DOSU_DEV !== "true") return HOOK_COMMAND;
  return `${devEnvAssignments().join(" ")} ${devSelfCommand()} memory hook`;
}

/** Ours in either form: `dosu memory hook`, or a dev command ending in `'<entry>' memory hook`. */
export function isMemoryHookCommand(command: unknown): boolean {
  return typeof command === "string" && /(?:\bdosu|')\s+memory hook\s*$/.test(command);
}

export function claudeSettingsPath(): string {
  return join(claudeConfigDir(), "settings.json");
}

/** Which of the events currently have the memory hook. */
export function memoryHookStatus(): Record<string, boolean> {
  const config = readHookConfig(claudeSettingsPath());
  return Object.fromEntries(
    MEMORY_HOOK_EVENTS.map(({ event }) => [
      event,
      hasGroupedHook(config, event, isMemoryHookCommand),
    ]),
  );
}

export function enableMemoryHooks(): void {
  const path = claudeSettingsPath();
  let config = readHookConfig(path);
  const command = memoryHookCommand();
  for (const { event, timeout } of MEMORY_HOOK_EVENTS) {
    config = addGroupedHook(config, event, { command, owns: isMemoryHookCommand, timeout });
  }
  writeHookConfig(path, config);
}

export function disableMemoryHooks(): void {
  const path = claudeSettingsPath();
  let config = readHookConfig(path);
  for (const { event } of MEMORY_HOOK_EVENTS) {
    config = removeGroupedHook(config, event, isMemoryHookCommand);
  }
  writeHookConfig(path, config);
}
