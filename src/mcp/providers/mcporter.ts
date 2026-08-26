import { existsSync } from "node:fs";
import { join } from "node:path";
import { type Config, MODE_OSS } from "../../config/config";
import { assertSafeProjectPath } from "../../setup/project-root";
import {
  getJSONServer,
  installJSONServer,
  isJSONKeyConfigured,
  mcpBaseURL,
  mcpHeaders,
  mcpURL,
  removeJSONServer,
} from "../config-helpers";
import { expandHome, isInstalled } from "../detect";
import { buildProjectProxyCommand, isDosuOwnedMcpServer } from "../project-proxy";
import type { SetupProvider } from "../providers";

function resolveGlobalConfigPath(): string {
  const jsonPath = expandHome("~/.mcporter/mcporter.json");
  if (existsSync(jsonPath)) return jsonPath;
  const jsoncPath = expandHome("~/.mcporter/mcporter.jsonc");
  if (existsSync(jsoncPath)) return jsoncPath;
  return jsonPath;
}

function mcpEndpoint(cfg: Config): string {
  if (cfg.mode === MODE_OSS) return mcpBaseURL();
  if (!cfg.active_account?.target?.deployment_id) throw new Error("deployment ID is required");
  return mcpURL(cfg.active_account?.target?.deployment_id);
}

function requireProjectRoot(projectRoot: string | undefined): string {
  if (!projectRoot) {
    throw new Error("MCPorter project installation requires an explicit project root");
  }
  return projectRoot;
}

function projectPath(projectRoot: string | undefined): string {
  const root = requireProjectRoot(projectRoot);
  const path = join(root, "config", "mcporter.json");
  assertSafeProjectPath(root, path);
  return path;
}

function isProjectConfigured(projectRoot: string): boolean {
  try {
    return isDosuOwnedMcpServer(getJSONServer(projectPath(projectRoot), "mcpServers"));
  } catch {
    return false;
  }
}

function assertReplaceableProjectEntry(configPath: string): void {
  const existing = getJSONServer(configPath, "mcpServers");
  if (existing !== undefined && !isDosuOwnedMcpServer(existing)) {
    throw new Error(
      'MCPorter already has a non-Dosu MCP server named "dosu"; refusing to overwrite it',
    );
  }
}

export const MCPorterProvider = (): SetupProvider => ({
  name: () => "MCPorter",
  id: () => "mcporter",
  configurationKind: () => "project",
  priority: () => 16,
  detectPaths: () => ["~/.mcporter"],
  isInstalled: () => isInstalled(["~/.mcporter"]),
  globalConfigPath: () => resolveGlobalConfigPath(),
  isConfigured: () => isJSONKeyConfigured(resolveGlobalConfigPath(), "mcpServers"),
  projectConfigPath: (projectRoot: string) => join(projectRoot, "config", "mcporter.json"),
  isProjectConfigured,

  install(cfg: Config, opts): void {
    const global = opts.scope === "global";
    const configPath = global ? resolveGlobalConfigPath() : projectPath(opts.projectRoot);
    if (!global) assertReplaceableProjectEntry(configPath);
    const server = global
      ? {
          type: "http",
          url: mcpEndpoint(cfg),
          // biome-ignore lint/style/noNonNullAssertion: guaranteed by install() guard
          headers: mcpHeaders(cfg.active_account!.target!.api_key!),
        }
      : buildProjectProxyCommand(cfg);
    installJSONServer(configPath, "mcpServers", server);
  },

  remove(opts): void {
    const global = opts.scope === "global";
    const configPath = global ? resolveGlobalConfigPath() : projectPath(opts.projectRoot);
    if (!global) {
      const existing = getJSONServer(configPath, "mcpServers");
      if (existing === undefined) return;
      if (!isDosuOwnedMcpServer(existing)) {
        throw new Error('MCPorter has a non-Dosu MCP server named "dosu"; refusing to remove it');
      }
    }
    removeJSONServer(configPath, "mcpServers");
  },
});
