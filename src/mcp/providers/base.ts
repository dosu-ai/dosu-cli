/**
 * Base provider class with shared JSON config operations.
 * Most providers follow the same install/remove pattern — only the config path and top-level key differ.
 */

import type { Config } from "../../config/config";
import {
  installJSONServer,
  isJSONKeyConfigured,
  mcpBaseURL,
  mcpHeaders,
  mcpURL,
  removeJSONServer,
} from "../config-helpers";
import { expandHome, isInstalled } from "../detect";
import type { SetupProvider } from "../providers";

export interface BaseProviderConfig {
  providerName: string;
  providerID: string;
  local: boolean;
  priorityValue: number;
  paths: string[];
  globalPath: string;
  topKey: string;
  /** Override the server entry shape if needed */
  // biome-ignore lint/suspicious/noExplicitAny: server entries are arbitrary JSON
  buildServer?: (cfg: Config) => Record<string, any>;
  /** For providers that use a different local config path pattern */
  localConfigPath?: (cwd: string) => string;
}

export function createJSONProvider(opts: BaseProviderConfig): SetupProvider {
  // biome-ignore lint/suspicious/noExplicitAny: server entries are arbitrary JSON
  const defaultBuildServer = (cfg: Config): Record<string, any> => ({
    type: "http",
    // biome-ignore lint/style/noNonNullAssertion: guaranteed by install() guard
    url: mcpURL(cfg.deployment_id!),
    // biome-ignore lint/style/noNonNullAssertion: guaranteed by install() guard
    headers: mcpHeaders(cfg.api_key!),
  });

  // biome-ignore lint/suspicious/noExplicitAny: server entries are arbitrary JSON
  const defaultBuildOSSServer = (cfg: Config): Record<string, any> => ({
    type: "http",
    url: mcpBaseURL(),
    // biome-ignore lint/style/noNonNullAssertion: guaranteed by install() guard
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
      if (cfg.mode !== "oss" && !cfg.deployment_id) throw new Error("deployment ID is required");
      let configPath: string;
      if (global) {
        configPath = expandHome(opts.globalPath);
      } else if (opts.localConfigPath) {
        configPath = opts.localConfigPath(process.cwd());
      } else {
        throw new Error(`${opts.providerName} does not support local installation`);
      }
      const serverBuilder = cfg.mode === "oss" ? defaultBuildOSSServer : buildServer;
      installJSONServer(configPath, opts.topKey, serverBuilder(cfg));
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
