/**
 * Setup integration for agent rules.
 *
 * MCP configuration remains the source of agent selection. Every successfully
 * configured supported agent receives the same Dosu rule automatically; an
 * agent removed from setup has its rule removed as well.
 */

import * as p from "@clack/prompts";
import { logger } from "../debug/logger";
import type { SetupProvider } from "../mcp/providers";
import {
  fetchDosuRule,
  installRuleForAgent,
  isRuleAgent,
  type RuleAction,
  removeRuleForAgent,
  rulePathForAgent,
} from "../rules/installer";
import { formatSetupSummary, IconRemove } from "./styles";

interface SetupSelection {
  toInstall: SetupProvider[];
  toRemove: SetupProvider[];
}

interface McpResult {
  provider: SetupProvider;
  action: "install" | "remove" | "skip";
  error?: Error;
}

export interface AgentRuleSetupResult {
  provider: SetupProvider;
  action: RuleAction;
  path: string;
  error?: Error;
}

function successfulAgentIDs(results: McpResult[], action: "install" | "remove"): Set<string> {
  return new Set(
    results
      .filter((result) => result.action === action && !result.error)
      .map((result) => result.provider.id()),
  );
}

function logRuleResults(results: AgentRuleSetupResult[]): void {
  const ready = results.filter(
    (result) =>
      !result.error &&
      (result.action === "created" || result.action === "updated" || result.action === "unchanged"),
  );
  const removed = results.filter((result) => !result.error && result.action === "removed");

  if (ready.length > 0) {
    p.log.success(
      formatSetupSummary(
        `Rules ready for ${ready.length} agent(s):`,
        ready.map((result) => ({ label: result.provider.name(), path: result.path })),
      ),
    );
  }

  if (removed.length > 0) {
    p.log.info(
      formatSetupSummary(
        `Rules removed from ${removed.length} agent(s):`,
        removed.map((result) => ({ label: result.provider.name(), path: result.path })),
        IconRemove,
      ),
    );
  }
}

export async function stepConfigureAgentRules(
  selection: SetupSelection,
  mcpResults: McpResult[],
  projectRoot?: string,
  canonicalRule?: string,
): Promise<AgentRuleSetupResult[]> {
  const successfulInstalls = successfulAgentIDs(mcpResults, "install");
  const successfulRemovals = successfulAgentIDs(mcpResults, "remove");
  const toInstall = selection.toInstall.filter(
    (provider) =>
      successfulInstalls.has(provider.id()) &&
      isRuleAgent(provider.id()) &&
      rulePathForAgent(provider.id(), projectRoot) !== null,
  );
  const toRemove = selection.toRemove.filter(
    (provider) =>
      successfulRemovals.has(provider.id()) &&
      isRuleAgent(provider.id()) &&
      rulePathForAgent(provider.id(), projectRoot) !== null,
  );
  const results: AgentRuleSetupResult[] = [];

  if (toInstall.length > 0) {
    const content = canonicalRule ?? (await fetchDosuRule());
    for (const provider of toInstall) {
      try {
        const installed = installRuleForAgent(provider.id(), content, projectRoot);
        if (installed) results.push({ provider, action: installed.action, path: installed.path });
      } catch (err: unknown) {
        const error = err instanceof Error ? err : new Error(String(err));
        logger.error(
          "setup",
          `Rule install failed for ${provider.name()}: ${error.stack ?? error.message}`,
        );
        p.log.error(`Failed to install ${provider.name()} rule: ${error.message}`);
        results.push({
          provider,
          action: "not_found",
          path: rulePathForAgent(provider.id(), projectRoot) ?? "",
          error,
        });
      }
    }
  }

  // Gemini CLI and Antigravity intentionally share ~/.gemini/GEMINI.md.
  // Keep the shared section if either selected agent still needs it.
  const retainedPaths = new Set(
    toInstall
      .map((provider) => rulePathForAgent(provider.id(), projectRoot))
      .filter((path): path is string => path !== null),
  );

  for (const provider of toRemove) {
    const path = rulePathForAgent(provider.id(), projectRoot);
    if (path && retainedPaths.has(path)) continue;

    try {
      const removed = removeRuleForAgent(provider.id(), projectRoot);
      if (removed) results.push({ provider, action: removed.action, path: removed.path });
    } catch (err: unknown) {
      const error = err instanceof Error ? err : new Error(String(err));
      logger.error(
        "setup",
        `Rule removal failed for ${provider.name()}: ${error.stack ?? error.message}`,
      );
      p.log.error(`Failed to remove ${provider.name()} rule: ${error.message}`);
      results.push({
        provider,
        action: "not_found",
        path: path ?? "",
        error,
      });
    }
  }

  logRuleResults(results);
  return results;
}
