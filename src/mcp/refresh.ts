/** Re-apply the Dosu MCP entry to every AI tool that is installed and already configured.
 * `install` rewrites the entry in place, so this is how config-shape changes (new provider
 * format, new deployment target, new API key) reach existing installs without a full setup. */

import type { Config } from "../config/config";
import { logger } from "../debug/logger";
import { allSetupProviders, type SetupProvider } from "./providers";

interface ProviderRefreshFailure {
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

/** Configured providers whose entry is not the shape this version writes. A provider whose check
 * throws counts as out of date, so the rewrite runs and reports the real error. */
export function staleProviders(cfg: Config | undefined): SetupProvider[] {
  return configuredProviders().filter((provider) => {
    try {
      return !provider.isCurrent(cfg);
    } catch {
      return true;
    }
  });
}

/** Rewrite the global Dosu MCP entry for each configured provider from `cfg`. Failures are
 * collected per provider so one unwritable config file never blocks the others. */
export function refreshConfiguredProviders(cfg: Config): ProviderRefreshResult {
  return refreshProviders(cfg, configuredProviders());
}

/** Rewrite the global Dosu MCP entry for each of `providers` from `cfg`. */
export function refreshProviders(cfg: Config, providers: SetupProvider[]): ProviderRefreshResult {
  const result: ProviderRefreshResult = { updated: [], failed: [] };
  for (const provider of providers) {
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
