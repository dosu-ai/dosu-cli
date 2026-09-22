/** Status-line installation per agent. Claude Code and Cursor CLI share the config shape
 * (`statusLine: {type: "command", command}`) and the stdin payload, so one installer covers both.
 * Opt-in only, and never clobbers a status line the user already has: that case reports the
 * one-liner to append to their own script instead. */

import { homedir } from "node:os";
import { join } from "node:path";
import {
  devEnvAssignments,
  devSelfCommand,
  readHookConfig,
  writeHookConfig,
} from "../hooks/formats";
import { expandHome, isInstalled } from "../mcp/detect";

export interface StatuslineAgent {
  id(): string;
  name(): string;
  /** The agent itself is present on this machine. */
  isInstalled(): boolean;
  configPath(): string;
  /** The config's status line is ours. */
  isEnabled(): boolean;
  /** Throws StatuslineConflictError when a non-Dosu status line is configured. */
  enable(): void;
  /** Removes our status line; a foreign one is left alone. Returns whether anything changed. */
  disable(): boolean;
}

const RENDER_ARGS = "knowledge statusline render --agent";

/** The command written into the agent config. Dev installs pin this working copy, prefixed with
 * `env` rather than bare `NAME=value` assignments because Cursor spawns the command without a
 * shell (shell-style argument splitting only), where a leading assignment is not an executable. */
export function statuslineCommand(agentId: string): string {
  if (process.env.DOSU_DEV !== "true") return `dosu ${RENDER_ARGS} ${agentId}`;
  return `env ${devEnvAssignments().join(" ")} ${devSelfCommand()} ${RENDER_ARGS} ${agentId}`;
}

export function isDosuStatuslineCommand(command: unknown): boolean {
  return typeof command === "string" && command.includes(RENDER_ARGS);
}

export class StatuslineConflictError extends Error {
  readonly existingCommand: string;
  /** What to add to the user's own script so Dosu shows up next to their line. */
  readonly suggestion: string;

  constructor(agentName: string, agentId: string, existingCommand: string) {
    super(
      `${agentName} already has a status line (${existingCommand}); leaving it alone. ` +
        "To show Dosu alongside it, pipe the payload your script reads from stdin into: " +
        `dosu ${RENDER_ARGS} ${agentId}`,
    );
    this.name = "StatuslineConflictError";
    this.existingCommand = existingCommand;
    this.suggestion = `printf '%s' "$input" | dosu ${RENDER_ARGS} ${agentId}`;
  }
}

function claudeConfigDir(): string {
  return process.env.CLAUDE_CONFIG_DIR || join(homedir(), ".claude");
}

function statuslineOf(config: Record<string, unknown>): Record<string, unknown> | undefined {
  const value = config.statusLine;
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function configAgent(options: {
  id: string;
  name: string;
  detectPath: () => string;
  configPath: () => string;
}): StatuslineAgent {
  const { id, name, configPath } = options;
  return {
    id: () => id,
    name: () => name,
    isInstalled: () => isInstalled([options.detectPath()]),
    configPath,
    isEnabled: () => isDosuStatuslineCommand(statuslineOf(readHookConfig(configPath()))?.command),
    enable: () => {
      const path = configPath();
      const config = readHookConfig(path);
      const existing = statuslineOf(config);
      if (existing && !isDosuStatuslineCommand(existing.command)) {
        throw new StatuslineConflictError(
          name,
          id,
          typeof existing.command === "string" ? existing.command : JSON.stringify(existing),
        );
      }
      // Keep any padding/interval the user set on an earlier Dosu install; refresh the command.
      config.statusLine = { ...existing, type: "command", command: statuslineCommand(id) };
      writeHookConfig(path, config);
    },
    disable: () => {
      const path = configPath();
      const config = readHookConfig(path);
      if (!isDosuStatuslineCommand(statuslineOf(config)?.command)) return false;
      delete config.statusLine;
      writeHookConfig(path, config);
      return true;
    },
  };
}

export function allStatuslineAgents(): StatuslineAgent[] {
  return [
    configAgent({
      id: "claude",
      name: "Claude Code",
      detectPath: claudeConfigDir,
      configPath: () => join(claudeConfigDir(), "settings.json"),
    }),
    configAgent({
      id: "cursor",
      name: "Cursor CLI",
      detectPath: () => expandHome("~/.cursor"),
      configPath: () => expandHome("~/.cursor/cli-config.json"),
    }),
  ];
}

export function getStatuslineAgent(id: string): StatuslineAgent | undefined {
  return allStatuslineAgents().find((agent) => agent.id() === id);
}
