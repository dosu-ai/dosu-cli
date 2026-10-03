/** Hook agent registry: which coding agents get a session-end trigger and how. A parallel to
 * `src/mcp/providers`, not an extension: hook-capable agents and their operations differ. */

import { join } from "node:path";
import { expandHome, isInstalled } from "../mcp/detect";
import { isShippingEnabled, loadSyncState } from "../sync/state";
import { claudeCodeInstalled, claudeConfigDir } from "./claude-code";
import { disableClaudeContextHook, installClaudeContextHook } from "./context";
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

function codexHome(): string {
  return process.env.CODEX_HOME ?? expandHome("~/.codex");
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
  };
}

export function allHookAgents(): HookAgent[] {
  return [
    claudeAgent(),
    cursorAgent(),
    groupedAgent({
      id: "codex",
      name: "Codex",
      detectPath: codexHome,
      configPath: () => join(codexHome(), "hooks.json"),
      event: "Stop",
      enableNote: "Codex asks you to trust new hooks; approve the Dosu hook when prompted.",
    }),
  ];
}

export function getHookAgent(id: string): HookAgent | undefined {
  return allHookAgents().find((agent) => agent.id() === id);
}
