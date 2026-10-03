/** The prompt-time memory hook: Claude Code runs `dosu knowledge context` on every prompt it is
 * about to submit, and the digest it prints (if any) lands in the model's context for that turn.
 * Installed and removed together with transcript shipping -- one switch for the memory system. */

import { join } from "node:path";
import { claudeCodeInstalled, claudeConfigDir } from "./claude-code";
import {
  addGroupedHook,
  devEnvAssignments,
  devSelfCommand,
  type HookSpec,
  hasGroupedHook,
  readHookConfig,
  removeGroupedHook,
  writeHookConfig,
} from "./formats";

/** Claude Code's event for "the user just submitted a prompt"; its hooks may return
 * `additionalContext`. SessionStart would be earlier but is useless here: it fires before the
 * task exists, which is exactly what the old AGENTS.md digest had to fake. */
export const CONTEXT_EVENT = "UserPromptSubmit";

const CONTEXT_HOOK_COMMAND = "dosu knowledge context";

/** Dev installs pin the working copy with env inline, as the sync hook's do. */
function contextHookCommand(): string {
  if (process.env.DOSU_DEV !== "true") return CONTEXT_HOOK_COMMAND;
  return `${devEnvAssignments().join(" ")} ${devSelfCommand()} knowledge context`;
}

function isDosuContextHookCommand(command: unknown): boolean {
  return typeof command === "string" && command.includes("knowledge context");
}

const CONTEXT_HOOK: HookSpec = {
  command: contextHookCommand,
  isOurs: isDosuContextHookCommand,
};

function settingsPath(): string {
  return join(claudeConfigDir(), "settings.json");
}

/** Install the hook, whether or not Claude Code has run here yet. */
export function installClaudeContextHook(): void {
  const path = settingsPath();
  writeHookConfig(path, addGroupedHook(readHookConfig(path), CONTEXT_EVENT, CONTEXT_HOOK));
}

/** Install the hook if Claude Code is present. Returns whether it is installed afterwards. Other
 * agents are not wired: Cursor's prompt hook cannot add context, and Codex's has not been
 * verified to. */
export function enableClaudeContextHook(): boolean {
  if (!claudeCodeInstalled()) return false;
  installClaudeContextHook();
  return true;
}

export function disableClaudeContextHook(): void {
  const path = settingsPath();
  const config = readHookConfig(path);
  if (!hasGroupedHook(config, CONTEXT_EVENT, CONTEXT_HOOK)) return;
  writeHookConfig(path, removeGroupedHook(config, CONTEXT_EVENT, CONTEXT_HOOK));
}
