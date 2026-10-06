/** Hook agent registry: which coding agents get a session-end trigger and how. A parallel to
 * `src/mcp/providers`, not an extension: hook-capable agents and their operations differ. */

import { join } from "node:path";
import { logger } from "../debug/logger";
import {
  disableIncognitoWithHooks,
  getIncognitoAgent,
  keptIncognitoNote,
} from "../incognito/agents";
import { expandHome, isInstalled } from "../mcp/detect";
import { isShippingEnabled, loadSyncState } from "../sync/state";
import { claudeCodeInstalled, claudeConfigDir } from "./claude-code";
import { codexHookAgent } from "./codex";
import {
  disableClaudeContextHook,
  hasClaudeContextHook,
  installClaudeContextHook,
} from "./context";
import {
  addCursorHook,
  addGroupedHook,
  hasCursorHook,
  hasGroupedHook,
  readHookConfig,
  removeCursorHook,
  removeGroupedHook,
  writeHookConfig,
} from "./formats";
import { opencodeHookAgent } from "./opencode";
import { piHookAgent } from "./pi";

export interface HookAgent {
  id(): string;
  name(): string;
  /** The agent itself is present on this machine. */
  isInstalled(): boolean;
  configPath(): string;
  isEnabled(): boolean;
  enable(): void;
  disable(): void;
  /** Extra guidance shown after enabling, when the agent needs it. */
  enableNote?(): string;
  /** Shown after disabling, when something stays behind or the agent's sessions still ship. */
  disableNote?(): string;
  /** Shown by `hooks status` while enabled, when part of what enable() installs is missing. */
  statusNote?(): string;
  /** Whether Dosu's config for the agent, as it is now, adds memory to its prompts. Absent for
   * agents that cannot take prompt-time memory (Cursor). */
  promptMemory?(): boolean;
  /** What adds prompt-time memory while promptMemory() is false, when enabling the agent's hooks
   * would not. */
  promptMemoryRemedy?(): string;
}

function groupedAgent(options: {
  id: string;
  name: string;
  detectPath: () => string;
  configPath: () => string;
  event: string;
  enableNote?: string;
}): HookAgent {
  return {
    id: () => options.id,
    name: () => options.name,
    isInstalled: () => isInstalled([options.detectPath()]),
    configPath: options.configPath,
    isEnabled: () => hasGroupedHook(readHookConfig(options.configPath()), options.event),
    enable: () => {
      const path = options.configPath();
      writeHookConfig(path, addGroupedHook(readHookConfig(path), options.event));
    },
    disable: () => {
      const path = options.configPath();
      writeHookConfig(path, removeGroupedHook(readHookConfig(path), options.event));
    },
    ...(options.enableNote ? { enableNote: () => options.enableNote as string } : {}),
  };
}

const CURSOR_EVENT = "stop";

function cursorAgent(): HookAgent {
  const configPath = () => expandHome("~/.cursor/hooks.json");
  return {
    id: () => "cursor",
    name: () => "Cursor",
    isInstalled: () => isInstalled(["~/.cursor"]),
    configPath,
    isEnabled: () => hasCursorHook(readHookConfig(configPath()), CURSOR_EVENT),
    enable: () => {
      writeHookConfig(configPath(), addCursorHook(readHookConfig(configPath()), CURSOR_EVENT));
    },
    disable: () => {
      writeHookConfig(configPath(), removeCursorHook(readHookConfig(configPath()), CURSOR_EVENT));
    },
  };
}

/** Claude Code: the SessionEnd trigger plus the prompt-time memory hook, one switch for both.
 * The prompt hook follows transcript shipping: left out while the user has opted out of it. */
function claudeAgent(): HookAgent {
  const sessionEnd = groupedAgent({
    id: "claude",
    name: "Claude Code",
    detectPath: claudeConfigDir,
    configPath: () => join(claudeConfigDir(), "settings.json"),
    event: "SessionEnd",
  });
  const shipping = () => isShippingEnabled(loadSyncState());
  return {
    ...sessionEnd,
    isInstalled: claudeCodeInstalled,
    enable: () => {
      sessionEnd.enable();
      if (shipping()) installClaudeContextHook();
    },
    disable: () => {
      sessionEnd.disable();
      disableClaudeContextHook();
    },
    enableNote: () =>
      shipping()
        ? ""
        : "Prompt-time memory stays off while transcript shipping is disabled; 'dosu knowledge transcripts enable' turns it on.",
    promptMemory: hasClaudeContextHook,
    statusNote: () =>
      shipping() && !hasClaudeContextHook()
        ? "Memory hooks (UserPromptSubmit, PreToolUse) are missing; 'dosu knowledge hooks enable claude' adds them."
        : "",
  };
}

/** The agent's incognito command (src/incognito/agents.ts) rides along with its hooks: once they
 * ship sessions, the user's one way to keep a session out is there before the first one needs it.
 * Written after the hooks, so a hook config Dosu cannot edit leaves no command behind either, and
 * removed with them only once transcript shipping is off (disableIncognitoWithHooks). OpenCode's
 * plugin and pi's extension install theirs themselves. */
function withIncognitoCommand(agent: HookAgent): HookAgent {
  const command = () => getIncognitoAgent(agent.id());
  return {
    ...agent,
    enable: () => {
      agent.enable();
      command()?.enable();
    },
    disable: () => {
      agent.disable();
      disableIncognitoWithHooks(agent.id());
    },
    disableNote: () => keptIncognitoNote(agent.id()),
    statusNote: () => {
      const missing = command();
      return [
        agent.statusNote?.() ?? "",
        missing && !missing.isEnabled()
          ? `${missing.invocation()} is missing; 'dosu knowledge hooks enable ${agent.id()}' adds it.`
          : "",
      ]
        .filter(Boolean)
        .join(" ");
    },
  };
}

export function allHookAgents(): HookAgent[] {
  return [
    withIncognitoCommand(claudeAgent()),
    withIncognitoCommand(cursorAgent()),
    withIncognitoCommand(codexHookAgent()),
    opencodeHookAgent(),
    piHookAgent(),
  ];
}

export function getHookAgent(id: string): HookAgent | undefined {
  return allHookAgents().find((agent) => agent.id() === id);
}

/** Re-apply, from this version's code, everything each agent with its hooks on has installed, so
 * what a release adds to them (another hook event, a new OpenCode plugin) reaches existing
 * installs without `hooks enable`. Agents whose hooks are off stay off. Returns the agents
 * refreshed; one that fails is logged and skipped. */
export function refreshEnabledHooks(): HookAgent[] {
  const refreshed: HookAgent[] = [];
  for (const agent of allHookAgents()) {
    try {
      if (!agent.isEnabled()) continue;
      agent.enable();
      refreshed.push(agent);
    } catch (err) {
      logger.error("hooks", `Refreshing ${agent.name()} hooks failed: ${err}`);
    }
  }
  return refreshed;
}
