/** First-run-after-upgrade safety net. The version that last checked the MCP entries is
 * remembered in the config dir. On the first command of any other version (the user upgraded via
 * npm, brew, or a fresh `npx` without going through `dosu upgrade`, which makes the same check
 * itself), every installed and already-configured AI tool whose Dosu entry is not the shape this
 * version's provider code writes gets it rewritten, so a format change can never leave an agent
 * broken. Entries that are already current are left alone, so most upgrades touch nothing. This
 * cannot prompt (it runs inside arbitrary commands, including agents' JSON calls), so it nudges
 * the user to run `dosu setup` for the rest of the bundle. Fail-open: any error is logged and
 * the next invocation retries. */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import pc from "picocolors";
import { type Config, getConfigDir, loadConfigNonBlocking, MODE_OSS } from "../config/config";
import { logger } from "../debug/logger";
import { refreshProviders, staleProviders } from "../mcp/refresh";
import { VERSION } from "./version";

const CACHE_FILENAME = "mcp-refresh.json";

interface McpRefreshCache {
  /** CLI version that last checked (and, where needed, rewrote) the configured MCP entries. */
  version: string;
}

function getCachePath(): string {
  return join(getConfigDir(), CACHE_FILENAME);
}

export function readMcpRefreshCache(): McpRefreshCache | null {
  try {
    const path = getCachePath();
    if (!existsSync(path)) return null;
    const data = JSON.parse(readFileSync(path, "utf-8"));
    if (typeof data?.version === "string") return { version: data.version };
    return null;
  } catch {
    return null;
  }
}

export function writeMcpRefreshCache(cache: McpRefreshCache): void {
  try {
    const dir = getConfigDir();
    if (!existsSync(dir)) {
      mkdirSync(dir, { recursive: true, mode: 0o700 });
    }
    writeFileSync(getCachePath(), JSON.stringify(cache), { mode: 0o600 });
  } catch {
    // Graceful degradation — cache write failure is non-fatal
  }
}

/** Whether `cfg` carries everything `provider.install` needs: an API key, plus a deployment
 * unless OSS mode points at the public endpoint. Session tokens are irrelevant — the MCP entry
 * embeds the key, not the session. */
export function canRefreshMcp(cfg: Config): boolean {
  const target = cfg.active_account?.target;
  if (!target?.api_key) return false;
  return cfg.mode === MODE_OSS || Boolean(target.deployment_id);
}

function displayNotice(names: string[]): void {
  console.error(
    `\n${pc.green(`✓ Dosu ${VERSION}: refreshed MCP config for ${names.join(", ")}`)}\n` +
      `${pc.dim(`  Run ${pc.cyan('"dosu setup"')} to also update hooks and rules, then restart your AI agents.`)}\n`,
  );
}

/** Rewrite out-of-date MCP entries once per version. Called synchronously from the preAction
 * hook. With `notify: false` the refresh still runs but prints nothing (the TUI owns the screen).
 * The marker is only written once the check has run against a usable config, so a signed-out
 * upgrade is reconciled on the first invocation after the user signs back in. */
export function checkForMcpRefresh(options: { notify?: boolean } = {}): void {
  const notify = options.notify ?? true;
  try {
    if (readMcpRefreshCache()?.version === VERSION) return;

    // Non-blocking read: a pre-action check must never stall a command on an odd config file.
    const cfg = loadConfigNonBlocking();
    if (!cfg || !canRefreshMcp(cfg)) {
      logger.debug("mcp-refresh", "Skipping MCP refresh: no API key or deployment configured");
      return;
    }

    const result = refreshProviders(cfg, staleProviders(cfg));
    writeMcpRefreshCache({ version: VERSION });
    logger.info(
      "mcp-refresh",
      `Version ${VERSION}: refreshed ${result.updated.length}, failed ${result.failed.length}`,
    );
    if (notify && result.updated.length > 0) {
      displayNotice(result.updated.map((provider) => provider.name()));
    }
  } catch (err) {
    logger.error("mcp-refresh", `MCP refresh check failed: ${err}`);
  }
}
