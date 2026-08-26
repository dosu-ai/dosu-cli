/**
 * Base provider class with shared JSON config operations.
 * Most providers follow the same install/remove pattern — only the config path and top-level key differ.
 */

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
import {
  buildProjectProxyCommand,
  isDosuOwnedMcpServer,
  type ProjectProxyCommand,
} from "../project-proxy";
import type { ProviderConfigurationKind, SetupProvider } from "../providers";

export interface BaseProviderConfig {
  providerName: string;
  providerID: string;
  configurationKind: ProviderConfigurationKind;
  priorityValue: number;
  paths: string[];
  globalPath: string;
  topKey: string;
  /** Override the server entry shape if needed */
  // biome-ignore lint/suspicious/noExplicitAny: server entries are arbitrary JSON
  buildServer?: (cfg: Config) => Record<string, any>;
  /** Exact provider-specific stdio shape for a secretless project entry. */
  buildProjectServer?: (command: ProjectProxyCommand) => Record<string, unknown>;
  /** For providers that use a different local config path pattern */
  localConfigPath?: (cwd: string) => string;
}

export function createJSONProvider(opts: BaseProviderConfig): SetupProvider {
  // biome-ignore lint/suspicious/noExplicitAny: server entries are arbitrary JSON
  const defaultBuildServer = (cfg: Config): Record<string, any> => ({
    type: "http",
    // biome-ignore lint/style/noNonNullAssertion: guaranteed by install() guard
    url: mcpURL(cfg.active_account!.target!.deployment_id!),
    headers: mcpHeaders(cfg.active_account?.target?.api_key),
  });

  // biome-ignore lint/suspicious/noExplicitAny: server entries are arbitrary JSON
  const defaultBuildOSSServer = (cfg: Config): Record<string, any> => ({
    type: "http",
    url: mcpBaseURL(),
    headers: mcpHeaders(cfg.active_account?.target?.api_key),
  });

  const buildServer = opts.buildServer ?? defaultBuildServer;
  const buildProjectServer =
    opts.buildProjectServer ??
    ((command: ProjectProxyCommand): Record<string, unknown> => ({
      type: "stdio",
      command: command.command,
      args: command.args,
    }));

  const projectConfigPath = (projectRoot: string): string | null =>
    opts.localConfigPath ? opts.localConfigPath(projectRoot) : null;

  const requireProjectRoot = (projectRoot: string | undefined): string => {
    if (!projectRoot) {
      throw new Error(
        `${opts.providerName} project installation requires an explicit project root`,
      );
    }
    return projectRoot;
  };

  return {
    name: () => opts.providerName,
    id: () => opts.providerID,
    configurationKind: () => opts.configurationKind,
    priority: () => opts.priorityValue,
    detectPaths: () => opts.paths,
    isInstalled: () => isInstalled(opts.paths),
    globalConfigPath: () => expandHome(opts.globalPath),
    isConfigured: () => isJSONKeyConfigured(expandHome(opts.globalPath), opts.topKey),
    projectConfigPath,
    isProjectConfigured: (projectRoot: string) => {
      const path = projectConfigPath(projectRoot);
      if (path) assertSafeProjectPath(projectRoot, path);
      if (!path) return false;
      try {
        return isDosuOwnedMcpServer(getJSONServer(path, opts.topKey));
      } catch {
        return false;
      }
    },
    removeLegacyGlobal: () => {
      const path = expandHome(opts.globalPath);
      try {
        if (hasSymlinkInPath(path)) return false;
        const existing = getJSONServer(path, opts.topKey);
        if (!isReleasedLegacyGlobalMcpServer(opts.providerID, existing)) return false;
        removeJSONServer(path, opts.topKey);
        return true;
      } catch {
        return false;
      }
    },

    install(cfg: Config, installOpts): void {
      if (cfg.mode !== MODE_OSS && !cfg.active_account?.target?.deployment_id)
        throw new Error("deployment ID is required");
      const global = installOpts.scope === "global";
      let configPath: string;
      if (global) {
        configPath = expandHome(opts.globalPath);
      } else if (opts.localConfigPath) {
        const projectRoot = requireProjectRoot(installOpts.projectRoot);
        configPath = opts.localConfigPath(projectRoot);
        assertSafeProjectPath(projectRoot, configPath);
      } else {
        throw new Error(`${opts.providerName} does not support local installation`);
      }
      if (global) {
        const serverBuilder = cfg.mode === MODE_OSS ? defaultBuildOSSServer : buildServer;
        installJSONServer(configPath, opts.topKey, serverBuilder(cfg));
      } else {
        const existing = getJSONServer(configPath, opts.topKey);
        if (existing !== undefined && !isDosuOwnedMcpServer(existing)) {
          throw new Error(
            `${opts.providerName} already has a non-Dosu MCP server named "dosu"; refusing to overwrite it`,
          );
        }
        installJSONServer(
          configPath,
          opts.topKey,
          buildProjectServer(buildProjectProxyCommand(cfg)),
        );
      }
    },

    remove(removeOpts): void {
      const global = removeOpts.scope === "global";
      let configPath: string;
      if (global) {
        configPath = expandHome(opts.globalPath);
      } else if (opts.localConfigPath) {
        const projectRoot = removeOpts.projectRoot;
        if (!projectRoot) {
          throw new Error(`${opts.providerName} project removal requires an explicit project root`);
        }
        configPath = opts.localConfigPath(projectRoot);
        assertSafeProjectPath(projectRoot, configPath);
      } else {
        throw new Error(`${opts.providerName} does not support local removal`);
      }
      if (!global) {
        const existing = getJSONServer(configPath, opts.topKey);
        if (existing === undefined) return;
        if (!isDosuOwnedMcpServer(existing)) {
          throw new Error(
            `${opts.providerName} has a non-Dosu MCP server named "dosu"; refusing to remove it`,
          );
        }
      }
      removeJSONServer(configPath, opts.topKey);
    },
  };
}
