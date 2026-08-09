/**
 * Base provider class with shared JSON config operations.
 * Most providers follow the same install/remove pattern — only the config path and top-level key differ.
 */

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

export interface BaseProviderConfig {
  providerName: string;
  providerID: string;
  local: boolean;
  priorityValue: number;
  paths: string[];
  globalPath: string;
  /** Historical global paths used only for detection, never for new writes. */
  configuredGlobalPaths?: string[];
  topKey: string;
  /** Override the server entry shape if needed */
  // biome-ignore lint/suspicious/noExplicitAny: server entries are arbitrary JSON
  buildServer?: (cfg: Config) => Record<string, any>;
  /** Exact provider-specific stdio shape for a secretless project entry. */
  buildProjectServer?: (
    command: ReturnType<typeof buildProjectProxyCommand>,
  ) => Record<string, unknown>;
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
    ((command: ReturnType<typeof buildProjectProxyCommand>) => ({
      type: "stdio",
      command: command.command,
      args: command.args,
    }));

  const projectConfigPath = (projectRoot: string): string | null =>
    opts.localConfigPath ? opts.localConfigPath(projectRoot) : null;
  const isOwned = (entry: unknown): boolean => isDosuMcpEntryForProvider(opts.providerID, entry);
  const isCurrentProjectEntry = (entry: unknown): boolean =>
    ownedProjectProxyOptionsForProvider(opts.providerID, entry) !== null;

  const requireProjectRoot = (projectRoot: string | undefined): string => {
    if (!projectRoot) {
      throw new Error(`${opts.providerName} project installation requires a verified project root`);
    }
    return projectRoot;
  };

  return {
    name: () => opts.providerName,
    id: () => opts.providerID,
    supportsLocal: () => opts.local,
    priority: () => opts.priorityValue,
    detectPaths: () => opts.paths,
    isInstalled: () => isInstalled(opts.paths),
    globalConfigPath: () => expandHome(opts.globalPath),
    isConfigured: () =>
      [opts.globalPath, ...(opts.configuredGlobalPaths ?? [])].some((path) =>
        isProjectJSONServerConfigured(expandHome(path), opts.topKey, isOwned),
      ),
    projectConfigPath,
    isProjectConfigured: (projectRoot: string) => {
      const path = projectConfigPath(projectRoot);
      return path ? isProjectJSONServerConfigured(path, opts.topKey, isCurrentProjectEntry) : false;
    },

    install(cfg: Config, global: boolean, installOpts = {}) {
      if (cfg.mode !== MODE_OSS && !cfg.active_account?.target?.deployment_id)
        throw new Error("deployment ID is required");
      let configPath: string;
      if (global) {
        configPath = expandHome(opts.globalPath);
      } else if (opts.localConfigPath) {
        const projectRoot = requireProjectRoot(installOpts.projectRoot);
        configPath = opts.localConfigPath(projectRoot);
        assertSafeProjectPath(projectRoot, configPath);
      } else {
        throw new Error(`${opts.providerName} does not support project installation`);
      }
      if (global) {
        const serverBuilder = cfg.mode === MODE_OSS ? defaultBuildOSSServer : buildServer;
        installJSONServer(configPath, opts.topKey, serverBuilder(cfg));
      } else {
        const desiredTarget =
          cfg.mode === MODE_OSS
            ? ({ oss: true } as const)
            : { deploymentID: cfg.active_account?.target?.deployment_id as string };
        return installProjectJSONServer(
          configPath,
          opts.topKey,
          buildProjectServer(buildProjectProxyCommand(cfg)),
          isOwned,
          (current) => {
            const currentTarget = ownedProjectProxyOptionsForProvider(opts.providerID, current);
            if (
              !installOpts.allowProjectRetarget &&
              (!currentTarget || !sameProjectProxyTarget(currentTarget, desiredTarget))
            ) {
              throw new Error(
                `Existing ${opts.providerName} project MCP targets something else; refusing to retarget. ` +
                  "pass an explicit deployment to retarget it",
              );
            }
          },
        );
      }
    },

    remove(global: boolean, removeOpts = {}) {
      let configPath: string;
      if (global) {
        configPath = expandHome(opts.globalPath);
      } else if (opts.localConfigPath) {
        const projectRoot = requireProjectRoot(removeOpts.projectRoot);
        configPath = opts.localConfigPath(projectRoot);
        assertSafeProjectPath(projectRoot, configPath);
      } else {
        throw new Error(`${opts.providerName} does not support project removal`);
      }
      if (global) removeJSONServer(configPath, opts.topKey);
      else return removeProjectJSONServer(configPath, opts.topKey, isOwned);
    },
  };
}
