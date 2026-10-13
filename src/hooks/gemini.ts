/** Gemini CLI's Dosu hooks, all in `~/.gemini/settings.json` (GEMINI_CLI_HOME relocates the
 * home), in the grouped shape Claude Code's settings use:
 *
 * - SessionEnd: the sync, which names the session that just ended so it ships at once. Gemini CLI
 *   does not wait for SessionEnd hooks, so the sync's detach parent only reads the payload and
 *   hands off.
 * - AfterAgent: fires after every turn and starts a plain sync, which ships sessions once they
 *   have been quiet for five minutes: the backstop for a session whose SessionEnd never ran (the
 *   CLI killed, an exit that did not wait).
 * - BeforeAgent: `dosu knowledge context --agent gemini-cli --format gemini`, whose
 *   additionalContext Gemini CLI appends to the prompt for the turn. Follows transcript shipping,
 *   like Claude Code's prompt hook.
 *
 * Hooks are on by default in Gemini CLI (0.63). */

import { join } from "node:path";
import { expandHome, isInstalled, isOnPath } from "../mcp/detect";
import { isShippingEnabled, loadSyncState } from "../sync/state";
import type { HookAgent } from "./agents";
import { contextHookCommand, isDosuContextHookCommand } from "./context";
import {
  addGroupedHook,
  type HookSpec,
  hasGroupedHook,
  readHookConfig,
  removeGroupedHook,
  SYNC_HOOK,
  writeHookConfig,
} from "./formats";

export const GEMINI_END_EVENT = "SessionEnd";
export const GEMINI_TURN_EVENT = "AfterAgent";
export const GEMINI_PROMPT_EVENT = "BeforeAgent";

/** The trajectory source Gemini CLI sessions ship as, which the prompt hook names too. */
export const GEMINI_AGENT = "gemini-cli";

const CONTEXT: HookSpec = {
  command: () => contextHookCommand(["--agent", GEMINI_AGENT, "--format", "gemini"]),
  isOurs: isDosuContextHookCommand,
};

/** Gemini CLI's home directory: GEMINI_CLI_HOME, else the user's (sessions/gemini.ts). */
export function geminiConfigDir(): string {
  return join(process.env.GEMINI_CLI_HOME || expandHome("~"), ".gemini");
}

export function geminiSettingsPath(): string {
  return join(geminiConfigDir(), "settings.json");
}

/** Gemini CLI is installed when its config directory exists or `gemini` is on PATH, as for Claude
 * Code: a fresh machine sets Dosu up before the agent's first run. */
export function geminiInstalled(): boolean {
  return isInstalled([geminiConfigDir()]) || isOnPath("gemini");
}

function hasPromptHook(): boolean {
  return hasGroupedHook(readHookConfig(geminiSettingsPath()), GEMINI_PROMPT_EVENT, CONTEXT);
}

export function geminiHookAgent(): HookAgent {
  const shipping = () => isShippingEnabled(loadSyncState());
  const path = geminiSettingsPath;
  return {
    id: () => "gemini",
    name: () => "Gemini CLI",
    isInstalled: geminiInstalled,
    configPath: path,
    // The end event is the switch; the post-upgrade refresh re-runs enable() for the rest.
    isEnabled: () => hasGroupedHook(readHookConfig(path()), GEMINI_END_EVENT, SYNC_HOOK),
    enable: () => {
      let config = readHookConfig(path());
      config = addGroupedHook(config, GEMINI_END_EVENT, SYNC_HOOK);
      config = addGroupedHook(config, GEMINI_TURN_EVENT, SYNC_HOOK);
      if (shipping()) config = addGroupedHook(config, GEMINI_PROMPT_EVENT, CONTEXT);
      writeHookConfig(path(), config);
    },
    disable: () => {
      let config = readHookConfig(path());
      config = removeGroupedHook(config, GEMINI_END_EVENT, SYNC_HOOK);
      config = removeGroupedHook(config, GEMINI_TURN_EVENT, SYNC_HOOK);
      config = removeGroupedHook(config, GEMINI_PROMPT_EVENT, CONTEXT);
      writeHookConfig(path(), config);
    },
    enableNote: () =>
      shipping()
        ? ""
        : "Prompt-time memory stays off while transcript shipping is disabled; 'dosu knowledge transcripts enable' turns it on.",
    promptMemory: hasPromptHook,
    statusNote: () =>
      shipping() && !hasPromptHook()
        ? "The memory hook (BeforeAgent) is missing; 'dosu knowledge hooks enable gemini' adds it."
        : "",
  };
}
