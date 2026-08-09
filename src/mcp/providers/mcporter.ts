import { existsSync } from "node:fs";
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
  if (!projectRoot)
    throw new Error("MCPorter project installation requires a verified project root");
  return projectRoot;
}

export const MCPorterProvider = (): SetupProvider => ({
  name: () => "MCPorter",
  id: () => "mcporter",
  supportsLocal: () => true,
  priority: () => 16,
  detectPaths: () => ["~/.mcporter"],
  isInstalled: () => isInstalled(["~/.mcporter"]),
  globalConfigPath: () => resolveGlobalConfigPath(),
  isConfigured: () =>
    isProjectJSONServerConfigured(resolveGlobalConfigPath(), "mcpServers", (entry) =>
      isDosuMcpEntryForProvider("mcporter", entry),
    ),
  projectConfigPath: (projectRoot) => join(projectRoot, "config", "mcporter.json"),
  isProjectConfigured: (projectRoot) =>
    isProjectJSONServerConfigured(
      join(projectRoot, "config", "mcporter.json"),
      "mcpServers",
      (entry) => Boolean(ownedProjectProxyOptionsForProvider("mcporter", entry)),
    ),

  install(cfg: Config, global: boolean, opts = {}) {
    const projectRoot = global ? undefined : requireProjectRoot(opts.projectRoot);
    const configPath = global
      ? resolveGlobalConfigPath()
      : join(projectRoot as string, "config", "mcporter.json");
    if (projectRoot) assertSafeProjectPath(projectRoot, configPath);
    if (global) {
      const server = {
        type: "http",
        url: mcpEndpoint(cfg),
        // biome-ignore lint/style/noNonNullAssertion: guaranteed by install() guard
        headers: mcpHeaders(cfg.active_account!.target!.api_key!),
      };
      installJSONServer(configPath, "mcpServers", server);
    } else {
      const command = buildProjectProxyCommand(cfg);
      const desiredTarget =
        cfg.mode === MODE_OSS
          ? ({ oss: true } as const)
          : { deploymentID: cfg.active_account?.target?.deployment_id as string };
      return installProjectJSONServer(
        configPath,
        "mcpServers",
        { command: command.command, args: command.args },
        (entry) => isDosuMcpEntryForProvider("mcporter", entry),
        (current) => {
          const currentTarget = ownedProjectProxyOptionsForProvider("mcporter", current);
          if (
            !opts.allowProjectRetarget &&
            (!currentTarget || !sameProjectProxyTarget(currentTarget, desiredTarget))
          ) {
            throw new Error(
              "Existing MCPorter project MCP targets something else; refusing to retarget. " +
                "Pass an explicit deployment to retarget it",
            );
          }
        },
      );
    }
  },

  remove(global: boolean, opts = {}) {
    const projectRoot = global ? undefined : requireProjectRoot(opts.projectRoot);
    const configPath = global
      ? resolveGlobalConfigPath()
      : join(projectRoot as string, "config", "mcporter.json");
    if (projectRoot) assertSafeProjectPath(projectRoot, configPath);
    if (global) removeJSONServer(configPath, "mcpServers");
    else
      return removeProjectJSONServer(configPath, "mcpServers", (entry) =>
        isDosuMcpEntryForProvider("mcporter", entry),
      );
  },
});
