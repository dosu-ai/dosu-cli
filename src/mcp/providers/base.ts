/**
 * Base provider class with shared JSON config operations.
 * Most providers follow the same install/remove pattern — only the config path and top-level key differ.
 */

import type { Config } from "../../config/config";
import {
  installJSONServer,
  isJSONKeyConfigured,
  mcpEndpoint,
  mcpHeaders,
  removeJSONServer,
} from "../config-helpers";
import { expandHome, isInstalled } from "../detect";
import type { SetupProvider } from "../providers";

/** The resolved Dosu MCP endpoint a provider writes into its config file. */
interface McpEndpoint {
  url: string;
  headers: Record<string, string>;
}

export interface BaseProviderConfig {
  providerName: string;
  providerID: string;
  local: boolean;
  priorityValue: number;
  paths: string[];
  globalPath: string;
  topKey: string;
  /**
   * Shapes the server entry for this tool's schema. Receives the endpoint
   * already resolved for the active mode (OSS vs cloud), so overrides never
   * need to know which mode they are in. Defaults to `{ type: "http", url, headers }`.
   */
  // biome-ignore lint/suspicious/noExplicitAny: server entries are arbitrary JSON
  buildServer?: (endpoint: McpEndpoint, cfg: Config) => Record<string, any>;
  /** For providers that use a different local config path pattern */
  localConfigPath?: (cwd: string) => string;
}

// biome-ignore lint/suspicious/noExplicitAny: server entries are arbitrary JSON
const defaultBuildServer = ({ url, headers }: McpEndpoint): Record<string, any> => ({
  type: "http",
  url,
  headers,
});

export function createJSONProvider(opts: BaseProviderConfig): SetupProvider {
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
      const endpoint: McpEndpoint = {
        url: mcpEndpoint(cfg),
        headers: mcpHeaders(cfg.active_account?.target?.api_key),
      };
      let configPath: string;
      if (global) {
        configPath = expandHome(opts.globalPath);
      } else if (opts.localConfigPath) {
        configPath = opts.localConfigPath(process.cwd());
      } else {
        throw new Error(`${opts.providerName} does not support local installation`);
      }
      installJSONServer(configPath, opts.topKey, buildServer(endpoint, cfg));
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
