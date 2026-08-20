/**
 * Shared kickoff helpers for post-setup agent handoffs (log mining).
 *
 * Supports Claude Code (`claude`), Codex (`codex`), and Cursor Agent
 * (`agent` / `cursor-agent`). When only the Cursor IDE binary is on PATH,
 * print a pasteable prompt. Do not spawn `cursor <cwd>`: that opens a
 * different window/project than a multi-root workspace that already
 * contains this folder, so Agent history will not match.
 */

import { spawnSync } from "node:child_process";
import { logger } from "../debug/logger";

export type KickoffAgent = "cursor" | "claude" | "codex";

const KICKOFF_AGENTS: readonly KickoffAgent[] = ["cursor", "claude", "codex"] as const;

const AGENT_LABELS: Record<KickoffAgent, string> = {
  cursor: "Cursor",
  claude: "Claude Code",
  codex: "Codex",
};

/** True when `bin` is resolvable on PATH. */
export function binOnPath(bin: string): boolean {
  const cmd = process.platform === "win32" ? "where" : "which";
  try {
    return spawnSync(cmd, [bin], { stdio: "ignore" }).status === 0;
  } catch {
    return false;
  }
}

export function kickoffAgentLabel(agent: KickoffAgent): string {
  return AGENT_LABELS[agent];
}

/** Prefer `agent`, then `cursor-agent` (Cursor's terminal agent CLI). */
export function cursorAgentBin(): string | null {
  if (binOnPath("agent")) return "agent";
  if (binOnPath("cursor-agent")) return "cursor-agent";
  return null;
}

function cursorIdeAvailable(): boolean {
  return binOnPath("cursor");
}

/**
 * Agents we can actually hand the prompt to, i.e. whose CLI is on PATH. The
 * Cursor IDE binary deliberately does not qualify: it can only print a prompt
 * to paste (see the module header), so counting it here would let it preempt a
 * Claude Code / Codex CLI that would have run the mining unattended.
 */
export function listAvailableKickoffAgents(): KickoffAgent[] {
  const out: KickoffAgent[] = [];
  if (cursorAgentBin()) out.push("cursor");
  if (binOnPath("claude")) out.push("claude");
  if (binOnPath("codex")) out.push("codex");
  return out;
}

function asKickoffAgent(id: string): KickoffAgent | null {
  if (id === "cursor" || id === "claude" || id === "codex") return id;
  if (id === "claude-desktop") return "claude";
  return null;
}

/**
 * Pick a kickoff agent. Prefer providers the user just configured (in that
 * order), then fall back to cursor → claude → codex among what's on PATH.
 * A Cursor IDE with no agent CLI is the last resort: it only prints a prompt
 * to paste, so it must never win over an agent we can launch outright.
 */
export function resolveKickoffAgent(
  preferredProviderIds: readonly string[] = [],
): KickoffAgent | null {
  const available = listAvailableKickoffAgents();

  for (const id of preferredProviderIds) {
    const mapped = asKickoffAgent(id);
    if (mapped && available.includes(mapped)) return mapped;
  }

  for (const agent of KICKOFF_AGENTS) {
    if (available.includes(agent)) return agent;
  }

  return cursorIdeAvailable() ? "cursor" : null;
}

export interface LaunchKickoffOptions {
  /** Extra argv before the prompt (e.g. Claude `--model haiku`). */
  extraArgs?: string[];
  /** Called when Cursor IDE is present but agent CLI is not (paste prompt). */
  onCursorSoftLaunch?: () => void;
}

/**
 * Hand the terminal (or Cursor IDE) to the chosen agent with `prompt`.
 * Returns true when a process was started without an immediate spawn error.
 */
export function launchKickoffAgent(
  agent: KickoffAgent,
  prompt: string,
  options: LaunchKickoffOptions = {},
): boolean {
  const shell = process.platform === "win32";
  const extra = options.extraArgs ?? [];

  if (agent === "claude") {
    logger.info("setup", "Handing off to Claude Code");
    const result = spawnSync("claude", [...extra, prompt], { stdio: "inherit", shell });
    if (result.error) {
      logger.warn("setup", `Claude Code launch failed: ${result.error.message}`);
      return false;
    }
    return true;
  }

  if (agent === "codex") {
    logger.info("setup", "Handing off to Codex");
    const result = spawnSync("codex", [...extra, prompt], { stdio: "inherit", shell });
    if (result.error) {
      logger.warn("setup", `Codex launch failed: ${result.error.message}`);
      return false;
    }
    return true;
  }

  // cursor
  const agentBin = cursorAgentBin();
  if (agentBin) {
    logger.info("setup", `Handing off to Cursor Agent (${agentBin})`);
    const result = spawnSync(agentBin, [...extra, prompt], { stdio: "inherit", shell });
    if (result.error) {
      logger.warn("setup", `Cursor Agent launch failed: ${result.error.message}`);
      return false;
    }
    return true;
  }

  if (cursorIdeAvailable()) {
    logger.info("setup", "Cursor agent CLI not on PATH; prompt printed for paste");
    options.onCursorSoftLaunch?.();
    return true;
  }

  logger.warn("setup", "No Cursor kickoff binary found");
  return false;
}
