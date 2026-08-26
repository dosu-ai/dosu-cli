/**
 * Permanent setup reconciliation for global files written by older Dosu CLIs.
 *
 * This module is the only destructive global-cleanup entry point. It checks
 * fixed provider paths, refuses shared/unsupported formats, and removes only
 * exact released Dosu structures after the corresponding project setup has
 * been independently verified.
 */

import { createHash } from "node:crypto";
import { existsSync, lstatSync, readFileSync, unlinkSync } from "node:fs";
import { getJSONServer, removeJSONServer } from "../mcp/config-helpers";
import { isReleasedLegacyGlobalMcpServer } from "../mcp/legacy-global";
import type { SetupProvider } from "../mcp/providers";
import { DOSU_RULE_SECTION_END, removeRuleForAgent, rulePathForAgent } from "../rules/installer";
import { hasSymlinkInPath } from "./project-root";

type LegacyGlobalComponent = "mcp" | "rule";
type LegacyGlobalStatus = "removed" | "not_found" | "preserved";

export interface LegacyGlobalOutcome {
  providerID: string;
  component: LegacyGlobalComponent;
  path: string | null;
  status: LegacyGlobalStatus;
  reason?:
    | "foreign_or_modified"
    | "shared_or_unsupported"
    | "symlink_or_non_file"
    | "write_failed"
    | "project_not_verified"
    | "not_selected";
}

export interface LegacyGlobalReconciliation {
  outcomes: LegacyGlobalOutcome[];
  removed: LegacyGlobalOutcome[];
  preserved: LegacyGlobalOutcome[];
}

const MCP_TOP_KEY: Readonly<Record<string, string>> = {
  claude: "mcpServers",
  cursor: "mcpServers",
  vscode: "servers",
  zed: "context_servers",
  copilot: "mcpServers",
  opencode: "mcp",
  mcporter: "mcpServers",
  factory: "mcpServers",
};

// Exact SHA-256 values of released standalone rule files. The Claude values
// are rules/dosu.md at ee85184, 56b4687, and 1712ef9; Cursor values are those
// same bytes with the released alwaysApply frontmatter.
const LEGACY_STANDALONE_RULE_HASHES: Readonly<Record<string, ReadonlySet<string>>> = {
  claude: new Set([
    "82771652853dcf8b4bf7256fbbe039d24b49a7b17604d691deb512464cb74c84",
    "159e7d77db73739c2f06a9859d03cadcf9c3d3d9a412471595cc995aab298330",
    "0c28ff8d34f31258be73307d8e417fed24cb6a7d9a85d7ce6330f6d640980917",
  ]),
  cursor: new Set([
    "c1e507aa52dad2c211246aa17fa5bcabc6bf135c31d59046d93c4b64a11cb561",
    "98337c715e5df540d50f5366ec1f88906b3ef038985fcf612b3a451d7f4a911e",
    "6e3259783ee2421c3138b17f9ffc7798eb786f1a3312df5118c206cbb23bc3c2",
  ]),
};

const RULE_SECTION_START = /<!-- dosu:rules:start(?: v\d+)? -->/g;

function outcome(
  providerID: string,
  component: LegacyGlobalComponent,
  path: string | null,
  status: LegacyGlobalStatus,
  reason?: LegacyGlobalOutcome["reason"],
): LegacyGlobalOutcome {
  return { providerID, component, path, status, ...(reason ? { reason } : {}) };
}

function isRegularUnlinkedFile(path: string): boolean {
  try {
    return !hasSymlinkInPath(path) && lstatSync(path).isFile();
  } catch {
    return false;
  }
}

function existingGlobalMcp(provider: SetupProvider): boolean {
  try {
    return provider.isConfigured();
  } catch {
    return false;
  }
}

/** Remove one exact historical MCP entry from a fixed provider path. */
export function cleanupLegacyGlobalMcp(provider: SetupProvider): LegacyGlobalOutcome {
  const providerID = provider.id();
  const path = provider.globalConfigPath();
  const topKey = MCP_TOP_KEY[providerID];
  if (!topKey) {
    return existingGlobalMcp(provider)
      ? outcome(providerID, "mcp", path, "preserved", "shared_or_unsupported")
      : outcome(providerID, "mcp", path, "not_found");
  }
  if (!existsSync(path)) return outcome(providerID, "mcp", path, "not_found");
  if (path.endsWith(".jsonc")) {
    return outcome(providerID, "mcp", path, "preserved", "shared_or_unsupported");
  }
  if (!isRegularUnlinkedFile(path)) {
    return outcome(providerID, "mcp", path, "preserved", "symlink_or_non_file");
  }

  try {
    const entry = getJSONServer(path, topKey);
    if (entry === undefined) return outcome(providerID, "mcp", path, "not_found");
    if (!isReleasedLegacyGlobalMcpServer(providerID, entry)) {
      return outcome(providerID, "mcp", path, "preserved", "foreign_or_modified");
    }
    removeJSONServer(path, topKey);
    if (getJSONServer(path, topKey) !== undefined) {
      return outcome(providerID, "mcp", path, "preserved", "write_failed");
    }
    return outcome(providerID, "mcp", path, "removed");
  } catch {
    return outcome(providerID, "mcp", path, "preserved", "write_failed");
  }
}

function hash(content: string): string {
  return createHash("sha256").update(content).digest("hex");
}

function markedRuleStatus(content: string): "owned" | "missing" | "ambiguous" {
  const starts = content.match(RULE_SECTION_START) ?? [];
  const ends = content.match(new RegExp(DOSU_RULE_SECTION_END, "g")) ?? [];
  if (starts.length === 0 && ends.length === 0) return "missing";
  return starts.length === 1 && ends.length === 1 ? "owned" : "ambiguous";
}

/** Remove one exact historical rule file or marker-owned section. */
export function cleanupLegacyGlobalRule(providerID: string): LegacyGlobalOutcome | null {
  const path = rulePathForAgent(providerID);
  if (!path) return null;
  if (!existsSync(path)) return outcome(providerID, "rule", path, "not_found");
  if (!isRegularUnlinkedFile(path)) {
    return outcome(providerID, "rule", path, "preserved", "symlink_or_non_file");
  }

  try {
    const content = readFileSync(path, "utf-8");
    const standaloneHashes = LEGACY_STANDALONE_RULE_HASHES[providerID];
    if (standaloneHashes) {
      if (!standaloneHashes.has(hash(content))) {
        return outcome(providerID, "rule", path, "preserved", "foreign_or_modified");
      }
      unlinkSync(path);
      return outcome(providerID, "rule", path, "removed");
    }

    // GEMINI.md is shared with project-unsupported Antigravity. Codex and
    // OpenCode have dedicated global marker sections that can be removed.
    if (providerID === "gemini" || providerID === "antigravity") {
      return markedRuleStatus(content) === "missing"
        ? outcome(providerID, "rule", path, "not_found")
        : outcome(providerID, "rule", path, "preserved", "shared_or_unsupported");
    }
    if (providerID !== "codex" && providerID !== "opencode") return null;

    const status = markedRuleStatus(content);
    if (status === "missing") return outcome(providerID, "rule", path, "not_found");
    if (status === "ambiguous") {
      return outcome(providerID, "rule", path, "preserved", "foreign_or_modified");
    }
    removeRuleForAgent(providerID);
    return outcome(providerID, "rule", path, "removed");
  } catch {
    return outcome(providerID, "rule", path, "preserved", "write_failed");
  }
}

/**
 * Reconcile after the whole project bundle succeeds. Re-running is safe:
 * already removed entries become `not_found`, while every uncertain case is
 * retained for the user.
 */
export function reconcileLegacyGlobalSetup(
  selectedProviders: readonly SetupProvider[],
  projectRoot: string,
  knownProviders: readonly SetupProvider[],
): LegacyGlobalReconciliation {
  const outcomes: LegacyGlobalOutcome[] = [];
  const selectedIDs = new Set(selectedProviders.map((provider) => provider.id()));

  for (const provider of selectedProviders) {
    if (!provider.isProjectConfigured(projectRoot)) {
      outcomes.push(
        outcome(
          provider.id(),
          "mcp",
          provider.globalConfigPath(),
          "preserved",
          "project_not_verified",
        ),
      );
      continue;
    }
    outcomes.push(cleanupLegacyGlobalMcp(provider));
    const rule = cleanupLegacyGlobalRule(provider.id());
    if (rule) outcomes.push(rule);
  }

  // Report, but never mutate, legacy global configs for agents outside this
  // successful project selection (including unsupported/global connectors).
  for (const provider of knownProviders) {
    if (selectedIDs.has(provider.id()) || !existingGlobalMcp(provider)) continue;
    outcomes.push(
      outcome(provider.id(), "mcp", provider.globalConfigPath(), "preserved", "not_selected"),
    );
  }

  return {
    outcomes,
    removed: outcomes.filter((item) => item.status === "removed"),
    preserved: outcomes.filter((item) => item.status === "preserved"),
  };
}
