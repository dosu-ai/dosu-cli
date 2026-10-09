/** The prompt-time memory hook: Claude Code runs `dosu knowledge context` on every prompt it is
 * about to submit, and the digest it prints (if any) lands in the model's context for that turn.
 * The same command guards Dosu's memory tools on PreToolUse: it stops them in a session the user
 * took off the record and tells the MCP proxy which session each call belongs to. Installed and
 * removed together with transcript shipping -- one switch for the memory system. */

import { join } from "node:path";
import { CLAUDE_MEMORY_TOOL_PATTERN } from "../mcp/call-session";
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

const MEMORY_TOOL_EVENT = "PreToolUse";

const MEMORY_TOOL_HOOK: HookSpec = { ...CONTEXT_HOOK, matcher: CLAUDE_MEMORY_TOOL_PATTERN };

function settingsPath(): string {
  return join(claudeConfigDir(), "settings.json");
}

/** Install the hook, whether or not Claude Code has run here yet. */
export function installClaudeContextHook(): void {
  const path = settingsPath();
  const config = addGroupedHook(readHookConfig(path), CONTEXT_EVENT, CONTEXT_HOOK);
  writeHookConfig(path, addGroupedHook(config, MEMORY_TOOL_EVENT, MEMORY_TOOL_HOOK));
}

/** Install the hook if Claude Code is present. Returns whether it is installed afterwards. Codex's
 * prompt hook is installed with its other hooks (hooks/codex.ts); Cursor's cannot add context. */
export function enableClaudeContextHook(): boolean {
  if (!claudeCodeInstalled()) return false;
  installClaudeContextHook();
  return true;
}

/** Whether Claude Code's settings carry the hook, on both of its events. */
export function hasClaudeContextHook(): boolean {
  const config = readHookConfig(settingsPath());
  return (
    hasGroupedHook(config, CONTEXT_EVENT, CONTEXT_HOOK) &&
    hasGroupedHook(config, MEMORY_TOOL_EVENT, MEMORY_TOOL_HOOK)
  );
}

export function disableClaudeContextHook(): void {
  const path = settingsPath();
  const config = readHookConfig(path);
  const events = [CONTEXT_EVENT, MEMORY_TOOL_EVENT].filter((event) =>
    hasGroupedHook(config, event, CONTEXT_HOOK),
  );
  if (events.length === 0) return;
  for (const event of events) removeGroupedHook(config, event, CONTEXT_HOOK);
  writeHookConfig(path, config);
}
