/**
 * Resolves the miner's write-knowledge rules at run time from the installed
 * Dosu skill, so updates to the skill repo reach every miner run without a
 * CLI release. The vendored copy (prompt-core.generated.ts) is only the
 * fallback for machines where the skill isn't installed yet.
 */

import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { logger } from "../debug/logger";
import { extractMinerCore } from "./prompt-core";
import { MINER_CORE_RULES } from "./prompt-core.generated";

const SKILL_PROMPT_RELPATH = join("log-to-dosu-knowledge", "references", "miner-system-prompt.md");

export interface MinerCoreRules {
  rules: string;
  /** Path of the skill file the rules came from, or "bundled" for the vendored fallback. */
  source: string;
}

/**
 * Where an installed copy of the skill's miner prompt can live, in resolution
 * order. Mirrors the install targets in src/commands/skill.ts: `npx skills`
 * keeps its canonical copies in ~/.agents/skills and symlinks or copies into
 * agent-specific dirs. DOSU_SKILL_REPO points straight at a checkout for
 * development.
 */
export function candidateSkillPromptPaths(env: NodeJS.ProcessEnv = process.env): string[] {
  const paths: string[] = [];
  if (env.DOSU_SKILL_REPO?.trim()) {
    paths.push(join(env.DOSU_SKILL_REPO.trim(), "skills", SKILL_PROMPT_RELPATH));
  }
  paths.push(join(homedir(), ".agents", "skills", SKILL_PROMPT_RELPATH));
  const claudeConfigDir = env.CLAUDE_CONFIG_DIR?.trim() || join(homedir(), ".claude");
  paths.push(join(claudeConfigDir, "skills", SKILL_PROMPT_RELPATH));
  paths.push(join(homedir(), ".codeium", "windsurf", "skills", SKILL_PROMPT_RELPATH));
  return paths;
}

/**
 * First readable installed copy wins; a file that exists but has broken
 * markers is skipped (debug-logged) rather than failing the run. Falls back
 * to the vendored copy so a fresh CLI install mines correctly before the
 * skill is installed.
 */
export function resolveMinerCoreRules(env: NodeJS.ProcessEnv = process.env): MinerCoreRules {
  for (const path of candidateSkillPromptPaths(env)) {
    let markdown: string;
    try {
      markdown = readFileSync(path, "utf-8");
    } catch {
      continue; // not installed here
    }
    try {
      return { rules: extractMinerCore(markdown), source: path };
    } catch (err) {
      logger.debug("miner", `skipping unusable skill rules at ${path}: ${err}`);
    }
  }
  return { rules: MINER_CORE_RULES, source: "bundled" };
}
