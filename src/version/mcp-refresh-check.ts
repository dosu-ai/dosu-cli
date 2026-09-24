/** First-run-after-upgrade safety net. The version that last rewrote the MCP entries is
 * remembered in the config dir; when the running CLI has crossed a release that changed the
 * shape of the entry (the user upgraded via npm, brew, or a fresh `npx` without going through
 * `dosu upgrade`, which re-runs setup itself), every installed and already-configured AI tool
 * gets its Dosu entry rewritten by the *new* provider code so the format change can never leave
 * an agent broken. Ordinary bumps that did not touch the entry leave the agents alone. This
 * cannot prompt (it runs inside arbitrary commands, including agents' JSON calls), so it nudges
 * the user to run `dosu setup` for the rest of the bundle. Fail-open: any error is logged and
 * the next invocation retries. */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import pc from "picocolors";
import { type Config, getConfigDir, loadConfigNonBlocking, MODE_OSS } from "../config/config";
import { logger } from "../debug/logger";
import { refreshConfiguredProviders } from "../mcp/refresh";
import { isNewerVersion } from "./update-check";
import { VERSION } from "./version";

const CACHE_FILENAME = "mcp-refresh.json";

/** Releases whose provider code changed what the Dosu MCP entry looks like. Add a version here
 * whenever a provider's `install` output changes shape; an upgrade or downgrade that crosses
 * one of these rewrites configured agents on the first run, nothing else does. */
export const MCP_FORMAT_CHANGES: readonly string[] = ["0.53.0"];

/** Whether moving from `previous` (the version that last wrote the entries; `null` when
 * unknown, i.e. the install predates this marker) to `current` crosses a format change. */
export function needsMcpRefresh(previous: string | null, current: string): boolean {
  if (previous === null) return true;
  if (previous === current) return false;
  const [older, newer] = isNewerVersion(current, previous)
    ? [previous, current]
    : [current, previous];
  // Crossed when older < change <= newer.
  return MCP_FORMAT_CHANGES.some(
    (change) => isNewerVersion(change, older) && !isNewerVersion(change, newer),
  );
}

interface McpRefreshCache {
  /** CLI version whose provider code last rewrote the configured MCP entries. */
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
      `${pc.dim(`  Run ${pc.cyan('"dosu setup"')} to also update skills, hooks, and rules, then restart your AI agents.`)}\n`,
  );
}

/** Re-apply MCP entries once after an upgrade that crossed a format change. Called
 * synchronously from the preAction hook. With `notify: false` the refresh still runs but prints
 * nothing (the TUI owns the screen). When a refresh is needed, the marker is only written after
 * it actually ran, so a signed-out upgrade is reconciled on the first invocation after the user
 * signs back in. */
export function checkForMcpRefresh(options: { notify?: boolean } = {}): void {
  const notify = options.notify ?? true;
  try {
    const previous = readMcpRefreshCache()?.version ?? null;
    if (previous === VERSION) return;
    if (!needsMcpRefresh(previous, VERSION)) {
      // Nothing about the entry changed between the two versions; just move the marker along.
      writeMcpRefreshCache({ version: VERSION });
      return;
    }

    // Non-blocking read: a pre-action check must never stall a command on an odd config file.
    const cfg = loadConfigNonBlocking();
    if (!cfg || !canRefreshMcp(cfg)) {
      logger.debug("mcp-refresh", "Skipping MCP refresh: no API key or deployment configured");
      return;
    }

    const result = refreshConfiguredProviders(cfg);
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
