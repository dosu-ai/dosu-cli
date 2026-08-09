/**
 * Temporary migration for Dosu CLI v0.43 and earlier.
 *
 * This entry point only checks fixed global paths used by released CLI versions.
 * Missing paths and cleanup failures are intentionally ignored.
 * After the legacy upgrade window, delete this module together with the
 * removeLegacyGlobal provider hooks and removeGlobalSkillQuietly helper.
 */

import { existsSync, readFileSync } from "node:fs";
import { removeGlobalSkillQuietly } from "../commands/skill";
import { removeRuleForAgent, rulePathForAgent } from "../rules/installer";
import { hasSymlinkInPath } from "./project-root";

interface LegacyGlobalMcpProvider {
  removeLegacyGlobal?: () => void;
}

const LEGACY_RULE_SECTION_START = "<!-- dosu:rules:start";
const STANDALONE_GLOBAL_RULE_AGENTS = new Set(["claude", "cursor"]);

export function cleanupLegacyGlobalMcp(provider: LegacyGlobalMcpProvider): void {
  try {
    provider.removeLegacyGlobal?.();
  } catch {
    // Compatibility cleanup must never make project setup fail.
  }
}

export function cleanupLegacyGlobalRule(agentID: string): void {
  try {
    // Released Claude/Cursor rules own the whole file, which users may have
    // edited. Without section markers we cannot safely remove only Dosu.
    if (STANDALONE_GLOBAL_RULE_AGENTS.has(agentID)) return;
    // Gemini CLI shares this global file with project-unsupported Antigravity.
    if (agentID === "gemini" || agentID === "antigravity") return;
    const path = rulePathForAgent(agentID);
    if (!path || !existsSync(path) || hasSymlinkInPath(path)) return;
    const content = readFileSync(path, "utf-8");
    if (!content.includes(LEGACY_RULE_SECTION_START)) return;
    removeRuleForAgent(agentID);
  } catch {
    // Compatibility cleanup must never make project setup fail.
  }
}

export async function cleanupLegacyGlobalSkill(providerIDs: readonly string[]): Promise<void> {
  try {
    await removeGlobalSkillQuietly(providerIDs);
  } catch {
    // Compatibility cleanup must never make project setup fail.
  }
}
