/**
 * AGENTS.md step — writes a marker-delimited Dosu section into the repo's
 * AGENTS.md during setup so coding agents are prompted to lean on the Dosu
 * MCP tools (pull knowledge before a task, write learnings back after).
 *
 * The section lives between HTML-comment markers so re-running setup updates
 * it in place instead of appending duplicates, and users can freely edit the
 * rest of the file.
 */

import { execSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import * as p from "@clack/prompts";
import { logger } from "../debug/logger";
import { dosuInvocation } from "./audit-handoff";
import { dim } from "./styles";

export const DOSU_SECTION_START = "<!-- dosu:mcp:start -->";
export const DOSU_SECTION_END = "<!-- dosu:mcp:end -->";

export type AgentsMdAction = "created" | "updated" | "unchanged";

export interface AgentsMdResult {
  path: string;
  action: AgentsMdAction;
}

/**
 * True when `cwd` is inside a git work tree. Gates whether setup offers the
 * AGENTS.md step at all — writing an AGENTS.md into an arbitrary directory
 * (home dir, /tmp) would just be litter.
 */
export function inGitWorkTree(cwd: string = process.cwd()): boolean {
  try {
    // Exits 0 but prints "false" in bare repos and inside .git itself, so
    // the stdout check matters — exit code alone is not enough.
    const stdout = execSync("git rev-parse --is-inside-work-tree", {
      cwd,
      stdio: ["ignore", "pipe", "ignore"],
    });
    return stdout.toString().trim() === "true";
  } catch {
    return false;
  }
}

export function buildDosuAgentsSection(dosuCmd: string = dosuInvocation()): string {
  return [
    DOSU_SECTION_START,
    "## Dosu",
    "",
    "Shared team knowledge lives in [Dosu](https://dosu.dev), via the Dosu MCP server.",
    "",
    "- Before a task, and for any codebase or docs questions: pull context with `read_knowledge` (or `init_knowledge`) before digging through source.",
    "- After a task: save durable learnings with `write_knowledge` (or `save_topic`).",
    "",
    `Missing these tools? Run \`${dosuCmd} setup --help\` — it covers agent-assisted setup.`,
    DOSU_SECTION_END,
  ].join("\n");
}

/**
 * Create AGENTS.md with the Dosu section, or upsert the section into an
 * existing file (replace between markers when present, append otherwise).
 */
export function upsertDosuAgentsSection(
  cwd: string = process.cwd(),
  dosuCmd: string = dosuInvocation(),
): AgentsMdResult {
  const path = join(cwd, "AGENTS.md");
  const section = buildDosuAgentsSection(dosuCmd);

  if (!existsSync(path)) {
    writeFileSync(path, `${section}\n`);
    return { path, action: "created" };
  }

  const existing = readFileSync(path, "utf-8");
  const start = existing.indexOf(DOSU_SECTION_START);
  const end = existing.indexOf(DOSU_SECTION_END);

  let next: string;
  if (start !== -1 && end !== -1 && end >= start) {
    next = existing.slice(0, start) + section + existing.slice(end + DOSU_SECTION_END.length);
  } else {
    next = `${existing.trimEnd()}\n\n${section}\n`;
  }

  if (next === existing) return { path, action: "unchanged" };
  writeFileSync(path, next);
  return { path, action: "updated" };
}

/**
 * Setup-flow wrapper: upsert the section and report via clack. Returns
 * `true` when AGENTS.md ends up carrying the Dosu section (including the
 * already-up-to-date case).
 */
export function stepUpdateAgentsMd(cwd: string = process.cwd()): boolean {
  logger.info("setup", "Step: update AGENTS.md");
  try {
    const result = upsertDosuAgentsSection(cwd);
    logger.info("setup", `AGENTS.md ${result.action} at ${result.path}`);
    if (result.action === "unchanged") {
      p.log.success(`AGENTS.md\n${dim("Dosu section already up to date")}`);
    } else {
      p.log.success(`AGENTS.md\n${dim(`Dosu section ${result.action} — ${result.path}`)}`);
    }
    return true;
  } catch (err: unknown) {
    /* v8 ignore next -- err is always Error in practice */
    const msg = err instanceof Error ? err.message : String(err);
    logger.error("setup", `AGENTS.md update failed: ${msg}`);
    p.log.error(`Could not update AGENTS.md: ${msg}`);
    return false;
  }
}
