/**
 * Hook agent registry — which coding agents get a session-end trigger and how.
 *
 * A parallel to `src/mcp/providers` rather than an extension of it:
 * hook-capable agents are not the same set as MCP-supported tools (Zed has an
 * MCP entry but no hooks; opencode needs a plugin, not a config entry), and
 * the operations differ (enable/disable a trigger vs install/remove a server
 * entry). Same registry pattern, same detection helpers, separate interface.
 *
 * v1 agents: Claude Code, Cursor, Codex. Event choice per agent:
 * - Claude Code: `SessionEnd` — fires on session termination and cannot block
 *   or steer the agent (unlike `Stop`, which can force continuation).
 * - Cursor: `stop` — fires when the agent loop finishes; Cursor has no
 *   session-end event. The watermark gate debounces per-turn firing.
 * - Codex: `Stop` in `~/.codex/hooks.json` (grouped format, verified against
 *   a live install). Codex records a trust hash per hook command in
 *   config.toml, so users are prompted to approve the hook on first run.
 */

import { join } from "node:path";
import { expandHome, isInstalled } from "../mcp/detect";
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
  detectPath: string;
  configPath: () => string;
  event: string;
  enableNote?: string;
}): HookAgent {
  return {
    id: () => options.id,
    name: () => options.name,
    isInstalled: () => isInstalled([options.detectPath]),
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

export function allHookAgents(): HookAgent[] {
  return [
    groupedAgent({
      id: "claude",
      name: "Claude Code",
      detectPath: "~/.claude",
      configPath: () => expandHome("~/.claude/settings.json"),
      event: "SessionEnd",
    }),
    cursorAgent(),
    groupedAgent({
      id: "codex",
      name: "Codex",
      detectPath: "~/.codex",
      configPath: () => join(codexHome(), "hooks.json"),
      event: "Stop",
      enableNote: "Codex asks you to trust new hooks; approve the Dosu hook when prompted.",
    }),
  ];
}

export function getHookAgent(id: string): HookAgent | undefined {
  return allHookAgents().find((agent) => agent.id() === id);
}
