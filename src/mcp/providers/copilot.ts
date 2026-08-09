import { join } from "node:path";
import { type Config, MODE_OSS } from "../../config/config";
import { assertSafeProjectPath } from "../../setup/project-path";
import {
  installJSONServer,
  installProjectJSONServer,
  isProjectJSONServerConfigured,
  mcpBaseURL,
  mcpHeaders,
  mcpURL,
  removeJSONServer,
  removeProjectJSONServer,
} from "../config-helpers";
import { expandHome, isInstalled } from "../detect";
import {
  buildProjectProxyCommand,
  isDosuMcpEntryForProvider,
  ownedProjectProxyOptionsForProvider,
  sameProjectProxyTarget,
} from "../project-proxy";
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
  if (!projectRoot)
    throw new Error("Copilot project installation requires a verified project root");
  return projectRoot;
}

export const CopilotProvider = (): SetupProvider => ({
  name: () => "GitHub Copilot CLI",
  id: () => "copilot",
  supportsLocal: () => true,
  priority: () => 13,
  detectPaths: () => [expandHome("~/.copilot")],
  isInstalled: () => isInstalled([expandHome("~/.copilot")]),
  globalConfigPath: () => globalPath(),
  isConfigured: () =>
    isProjectJSONServerConfigured(globalPath(), "mcpServers", (entry) =>
      isDosuMcpEntryForProvider("copilot", entry),
    ),
  projectConfigPath: (projectRoot) => join(projectRoot, ".mcp.json"),
  isProjectConfigured: (projectRoot) =>
    isProjectJSONServerConfigured(join(projectRoot, ".mcp.json"), "mcpServers", (entry) =>
      Boolean(ownedProjectProxyOptionsForProvider("copilot", entry)),
    ),

  install(cfg: Config, global: boolean, opts = {}) {
    const url = mcpEndpoint(cfg);

    if (global) {
      const server = {
        type: "http",
        url,
        tools: ["*"],
        // biome-ignore lint/style/noNonNullAssertion: guaranteed by install() guard
        headers: mcpHeaders(cfg.active_account!.target!.api_key!),
      };
      installJSONServer(globalPath(), "mcpServers", server);
    } else {
      const projectRoot = requireProjectRoot(opts.projectRoot);
      const configPath = join(projectRoot, ".mcp.json");
      assertSafeProjectPath(projectRoot, configPath);
      const command = buildProjectProxyCommand(cfg);
      const desiredTarget =
        cfg.mode === MODE_OSS
          ? ({ oss: true } as const)
          : { deploymentID: cfg.active_account?.target?.deployment_id as string };
      const server = {
        type: "stdio",
        command: command.command,
        args: command.args,
      };
      return installProjectJSONServer(
        configPath,
        "mcpServers",
        server,
        (entry) => isDosuMcpEntryForProvider("copilot", entry),
        (current) => {
          const currentTarget = ownedProjectProxyOptionsForProvider("copilot", current);
          if (
            !opts.allowProjectRetarget &&
            (!currentTarget || !sameProjectProxyTarget(currentTarget, desiredTarget))
          ) {
            throw new Error(
              "Existing GitHub Copilot CLI project MCP targets something else; refusing to retarget. " +
                "Pass an explicit deployment to retarget it",
            );
          }
        },
      );
    }
  },

  remove(global: boolean, opts = {}) {
    if (global) {
      removeJSONServer(globalPath(), "mcpServers");
    } else {
      const projectRoot = requireProjectRoot(opts.projectRoot);
      const configPath = join(projectRoot, ".mcp.json");
      assertSafeProjectPath(projectRoot, configPath);
      return removeProjectJSONServer(configPath, "mcpServers", (entry) =>
        isDosuMcpEntryForProvider("copilot", entry),
      );
    }
  },
});
