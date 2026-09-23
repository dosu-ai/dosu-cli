/** Re-apply the Dosu MCP entry to every AI tool that is installed and already configured.
 * `install` rewrites the entry in place, so this is how config-shape changes (new provider
 * format, new deployment target, new API key) reach existing installs without a full setup. */

import type { Config } from "../config/config";
import { logger } from "../debug/logger";
import { allSetupProviders, type SetupProvider } from "./providers";

export interface ProviderRefreshFailure {
  provider: SetupProvider;
  error: Error;
}

export interface ProviderRefreshResult {
  updated: SetupProvider[];
  failed: ProviderRefreshFailure[];
}

/** Providers whose tool is on this machine and whose global config already carries Dosu.
 * Detection reads other tools' files, so a provider that throws is treated as absent. */
export function configuredProviders(): SetupProvider[] {
  return allSetupProviders().filter((provider) => {
    try {
      return provider.isInstalled() && provider.isConfigured();
    } catch {
      return false;
    }
  });
}

/** Rewrite the global Dosu MCP entry for each configured provider from `cfg`. Failures are
 * collected per provider so one unwritable config file never blocks the others. */
export function refreshConfiguredProviders(cfg: Config): ProviderRefreshResult {
  const result: ProviderRefreshResult = { updated: [], failed: [] };
  for (const provider of configuredProviders()) {
    try {
      provider.install(cfg, true);
      logger.info("mcp", `Refreshed ${provider.name()} MCP entry`);
      result.updated.push(provider);
    } catch (err: unknown) {
      const error = err instanceof Error ? err : new Error(String(err));
      logger.error("mcp", `Refresh failed for ${provider.name()}: ${error.message}`);
      result.failed.push({ provider, error });
    }
  }
  return result;
}
