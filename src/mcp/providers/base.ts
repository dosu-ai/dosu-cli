/**
 * Base provider class with shared JSON config operations.
 * Most providers follow the same install/remove pattern — only the config path and top-level key differ.
 */

import type { Config } from "../../config/config";
import type { SetupProvider } from "../providers";
import { isInstalled, expandHome } from "../detect";
import {
  mcpURL,
  mcpHeaders,
  isJSONKeyConfigured,
  installJSONServer,
  removeJSONServer,
} from "../config-helpers";

export interface BaseProviderConfig {
  providerName: string;
  providerID: string;
  local: boolean;
  priorityValue: number;
  paths: string[];
  globalPath: string;
  topKey: string;
  /** Override the server entry shape if needed */
  buildServer?: (cfg: Config) => Record<string, any>;
  /** For providers that use a different local config path pattern */
  localConfigPath?: (cwd: string) => string;
}

export function createJSONProvider(opts: BaseProviderConfig): SetupProvider {
  const defaultBuildServer = (cfg: Config): Record<string, any> => ({
    type: "http",
    url: mcpURL(cfg.deployment_id!),
    headers: mcpHeaders(cfg.api_key!),
  });

  const buildServer = opts.buildServer ?? defaultBuildServer;

  return {
    name: () => opts.providerName,
    id: () => opts.providerID,
    supportsLocal: () => opts.local,
    priority: () => opts.priorityValue,
    detectPaths: () => opts.paths,
    isInstalled: () => isInstalled(opts.paths),
    globalConfigPath: () => expandHome(opts.globalPath),
    isConfigured: () => isJSONKeyConfigured(expandHome(opts.globalPath), opts.topKey),

    install(cfg: Config, global: boolean): void {
      if (!cfg.deployment_id) throw new Error("deployment ID is required");
      let configPath: string;
      if (global) {
        configPath = expandHome(opts.globalPath);
      } else if (opts.localConfigPath) {
        configPath = opts.localConfigPath(process.cwd());
      } else {
        throw new Error(`${opts.providerName} does not support local installation`);
      }
      installJSONServer(configPath, opts.topKey, buildServer(cfg));
    },

    remove(global: boolean): void {
      let configPath: string;
      if (global) {
        configPath = expandHome(opts.globalPath);
      } else if (opts.localConfigPath) {
        configPath = opts.localConfigPath(process.cwd());
      } else {
        throw new Error(`${opts.providerName} does not support local removal`);
      }
      removeJSONServer(configPath, opts.topKey);
    },
  };
}
