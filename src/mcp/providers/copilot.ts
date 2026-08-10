import { join } from "node:path";
import { type Config, MODE_OSS } from "../../config/config";
import { assertSafeProjectPath, hasSymlinkInPath } from "../../setup/project-root";
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
import { isReleasedLegacyGlobalMcpServer } from "../legacy-global";
import { buildProjectProxyCommand, isDosuOwnedMcpServer } from "../project-proxy";
import type { SetupProvider } from "../providers";

function globalPath(): string {
  if (process.env.XDG_CONFIG_HOME) {
    return join(process.env.XDG_CONFIG_HOME, "mcp-config.json");
  }
  return expandHome("~/.copilot/mcp-config.json");
}

function mcpEndpoint(cfg: Config): string {
  if (cfg.mode === MODE_OSS) return mcpBaseURL();
  if (!cfg.active_account?.target?.deployment_id) throw new Error("deployment ID is required");
  return mcpURL(cfg.active_account?.target?.deployment_id);
}

function requireProjectRoot(projectRoot: string | undefined): string {
  if (!projectRoot) {
    throw new Error("GitHub Copilot CLI project installation requires an explicit project root");
  }
  return projectRoot;
}

function projectPath(projectRoot: string | undefined): string {
  const root = requireProjectRoot(projectRoot);
  const path = join(root, ".mcp.json");
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
      'GitHub Copilot CLI already has a non-Dosu MCP server named "dosu"; refusing to overwrite it',
    );
  }
}

export const CopilotProvider = (): SetupProvider => ({
  name: () => "GitHub Copilot CLI",
  id: () => "copilot",
  supportsLocal: () => true,
  priority: () => 13,
  detectPaths: () => [expandHome("~/.copilot")],
  isInstalled: () => isInstalled([expandHome("~/.copilot")]),
  globalConfigPath: () => globalPath(),
  isConfigured: () => isJSONKeyConfigured(globalPath(), "mcpServers"),
  projectConfigPath: (projectRoot: string) => join(projectRoot, ".mcp.json"),
  isProjectConfigured,
  removeLegacyGlobal: () => {
    const configPath = globalPath();
    try {
      if (hasSymlinkInPath(configPath)) return false;
      const existing = getJSONServer(configPath, "mcpServers");
      if (!isReleasedLegacyGlobalMcpServer("copilot", existing)) return false;
      removeJSONServer(configPath, "mcpServers");
      return true;
    } catch {
      return false;
    }
  },

  install(cfg: Config, global: boolean, opts = {}): void {
    if (global) {
      const url = mcpEndpoint(cfg);
      const server = {
        type: "http",
        url,
        tools: ["*"],
        // biome-ignore lint/style/noNonNullAssertion: guaranteed by install() guard
        headers: mcpHeaders(cfg.active_account!.target!.api_key!),
      };
      installJSONServer(globalPath(), "mcpServers", server);
    } else {
      const configPath = projectPath(opts.projectRoot);
      assertReplaceableProjectEntry(configPath);
      const command = buildProjectProxyCommand(cfg);
      const server = {
        type: "stdio",
        command: command.command,
        args: command.args,
      };
      installJSONServer(configPath, "mcpServers", server);
    }
  },

  remove(global: boolean, opts = {}): void {
    if (global) {
      removeJSONServer(globalPath(), "mcpServers");
    } else {
      const configPath = projectPath(opts.projectRoot);
      const existing = getJSONServer(configPath, "mcpServers");
      if (existing === undefined) return;
      if (!isDosuOwnedMcpServer(existing)) {
        throw new Error(
          'GitHub Copilot CLI has a non-Dosu MCP server named "dosu"; refusing to remove it',
        );
      }
      removeJSONServer(configPath, "mcpServers");
    }
  },
});
