/**
 * Post-setup audit handoff — instead of ending setup with a "paste this into
 * your agent" gap, offer to launch Claude Code directly with a prompt that
 * runs the Dosu codebase audit end-to-end (skill audit → `.dosu/audit.json`
 * → `dosu audit --tasks ...` to fire doc generation).
 *
 * The confirm happens inside the clack session (before `p.outro`); the actual
 * launch must happen after it so Claude Code gets a clean terminal — hence the
 * offer/launch split.
 */

import { spawnSync } from "node:child_process";
import * as p from "@clack/prompts";
import { logger } from "../debug/logger";
import { detectGitRepo } from "./github-step";
import { info } from "./styles";

export function buildAuditHandoffPrompt(dosuCmd: string = dosuInvocation()): string {
  return [
    "Audit this repository to see what docs Dosu can generate for it.",
    "1. Run the codebase audit from the Dosu skill. It writes findings to .dosu/audit.json.",
    "2. Show me the findings and which docs you recommend Dosu generate.",
    `3. Once I confirm, run \`${dosuCmd} audit --tasks <comma-separated task ids> --json\` to kick off generation. Dosu opens a PR and the CLI notifies me when it's ready.`,
  ].join("\n");
}

/** True when `bin` is resolvable on PATH. */
function binOnPath(bin: string): boolean {
  const cmd = process.platform === "win32" ? "where" : "which";
  try {
    return spawnSync(cmd, [bin], { stdio: "ignore" }).status === 0;
  } catch {
    return false;
  }
}

/** True when the `claude` CLI is resolvable on PATH. */
export function claudeCliAvailable(): boolean {
  return binOnPath("claude");
}

/**
 * How to invoke this CLI on the user's machine. Setup is often run via
 * `npx @dosu/cli` with no global install, in which case a bare `dosu` in the
 * prompt or nudge would fail when the agent (or user) copies it.
 */
export function dosuInvocation(): string {
  return binOnPath("dosu") ? "dosu" : "npx -y @dosu/cli";
}

/**
 * Manual fallback when we can't (or shouldn't) hand off: the same audit nudge
 * setup used to print unconditionally.
 */
export function printManualAuditNudge(): void {
  p.log.message(
    `See what docs Dosu can generate for this repo:\n\n${info("Ask Dosu to audit this repo and show what docs it can generate.")}\n\nOr run ${info(`${dosuInvocation()} audit`)} after your agent writes the audit.`,
  );
}

/**
 * Offer to kick off the audit in Claude Code. Returns `true` when the caller
 * should call `launchAuditAgent()` after the clack outro. Prints the manual
 * nudge when Claude Code is unavailable or the user declines; stays silent
 * when the cwd isn't a GitHub repo (the audit can't run there at all).
 */
export async function offerAuditHandoff(): Promise<boolean> {
  if (!detectGitRepo()) return false;
  if (!claudeCliAvailable()) {
    printManualAuditNudge();
    return false;
  }
  const go = await p.confirm({
    message: "Kick off the codebase audit in Claude Code now?",
    initialValue: true,
  });
  if (p.isCancel(go) || !go) {
    printManualAuditNudge();
    return false;
  }
  return true;
}

/** Hand the terminal to Claude Code with the audit prompt. Blocks until it exits. */
export function launchAuditAgent(): void {
  logger.info("setup", "Handing off to Claude Code for the codebase audit");
  const result = spawnSync("claude", [buildAuditHandoffPrompt()], { stdio: "inherit" });
  if (result.error) {
    logger.warn("setup", `Claude Code launch failed: ${result.error.message}`);
    printManualAuditNudge();
  }
}
