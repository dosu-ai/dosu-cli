/** The prompt-time memory hook: Claude Code runs `dosu knowledge context` on every prompt it is
 * about to submit, and the digest it prints (if any) lands in the model's context for that turn.
 * Installed and removed together with transcript shipping -- one switch for the memory system. */

import { join } from "node:path";
import { isInstalled } from "../mcp/detect";
import { claudeConfigDir } from "./agents";
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

/** `dosu knowledge context` plus `args` (another agent's --agent/--format). Dev installs pin the
 * working copy with env inline, as the sync hook's do. */
export function contextHookCommand(args: readonly string[] = []): string {
  const suffix = args.length > 0 ? ` ${args.join(" ")}` : "";
  if (process.env.DOSU_DEV !== "true") return `${CONTEXT_HOOK_COMMAND}${suffix}`;
  return `${devEnvAssignments().join(" ")} ${devSelfCommand()} knowledge context${suffix}`;
}

export function isDosuContextHookCommand(command: unknown): boolean {
  return typeof command === "string" && command.includes("knowledge context");
}

const CONTEXT_HOOK: HookSpec = {
  command: () => contextHookCommand(),
  isOurs: isDosuContextHookCommand,
};

function settingsPath(): string {
  return join(claudeConfigDir(), "settings.json");
}

/** Install the hook if Claude Code is present. Returns whether it is installed afterwards. Codex's
 * prompt hook is installed with its other hooks (hooks/codex.ts); Cursor's cannot add context. */
export function enableClaudeContextHook(): boolean {
  if (!isInstalled([claudeConfigDir()])) return false;
  const path = settingsPath();
  writeHookConfig(path, addGroupedHook(readHookConfig(path), CONTEXT_EVENT, CONTEXT_HOOK));
  return true;
}

export function disableClaudeContextHook(): void {
  const path = settingsPath();
  const config = readHookConfig(path);
  if (!hasGroupedHook(config, CONTEXT_EVENT, CONTEXT_HOOK)) return;
  writeHookConfig(path, removeGroupedHook(config, CONTEXT_EVENT, CONTEXT_HOOK));
}
