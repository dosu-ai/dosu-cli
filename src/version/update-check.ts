/**
 * Cached version update checker.
 *
 * Uses a cached, bounded check:
 * 1. On startup, reads a cached latest version from disk.
 * 2. If the cached version is newer than the running version, prints a notice to stderr.
 * 3. If the cache is stale (>6 h), waits up to one second and can print on the same run.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import pc from "picocolors";
import { getConfigDir } from "../config/config";
import { logger } from "../debug/logger";
import { INSTALL_CHANNEL, isNpxInvocation, VERSION } from "./version";

const CACHE_FILENAME = "update-check.json";
const CHECK_INTERVAL_MS = 6 * 60 * 60 * 1000;
const FETCH_TIMEOUT_MS = 1_000;
const REGISTRY_URL = "https://registry.npmjs.org/-/package/@dosu/cli/dist-tags";
const SEMVER_PATTERN =
  /^(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)(?:-[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/;

interface UpdateCache {
  lastCheck: number;
  latestVersion: string;
}

function isValidVersion(value: unknown): value is string {
  return typeof value === "string" && SEMVER_PATTERN.test(value);
}

/** Strip pre-release/build metadata from a semver string (e.g. "1.2.3-beta.1+build" → "1.2.3"). */
function stripPrerelease(version: string): string {
  return version.replace(/[-+].*$/, "");
}

/** Compare two semver strings. Returns true if `latest` is newer than `current`. */
export function isNewerVersion(latest: string, current: string): boolean {
  const a = stripPrerelease(latest).split(".").map(Number);
  const b = stripPrerelease(current).split(".").map(Number);
  const len = Math.max(a.length, b.length);
  for (let i = 0; i < len; i++) {
    const av = a[i] ?? 0;
    const bv = b[i] ?? 0;
    if (av > bv) return true;
    if (av < bv) return false;
  }
  return false;
}

function getCachePath(): string {
  return join(getConfigDir(), CACHE_FILENAME);
}

function readCache(): UpdateCache | null {
  try {
    const path = getCachePath();
    if (!existsSync(path)) return null;
    const data = JSON.parse(readFileSync(path, "utf-8"));
    if (typeof data.lastCheck === "number" && isValidVersion(data.latestVersion)) {
      return data as UpdateCache;
    }
    return null;
  } catch {
    return null;
  }
}

function writeCache(cache: UpdateCache): void {
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

/** Fetch the latest published version from the npm registry. */
export async function fetchLatestVersion(): Promise<string | null> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    const resp = await fetch(REGISTRY_URL, { signal: controller.signal });
    if (!resp.ok) return null;
    const data = (await resp.json()) as Record<string, string>;
    const latest = data.latest;
    return isValidVersion(latest) ? latest : null;
  } catch {
    return null;
  } finally {
    clearTimeout(timeout);
  }
}

export function buildUpdateHint(channel: string, npx = false): string {
  if (channel === "npm" && npx) {
    return 'Use "npx -y @dosu/cli@latest" for the next Dosu command';
  }
  return 'Run "dosu upgrade"';
}

export function buildUpdateNotice(
  current: string,
  latest: string,
  channel: string,
  interactive: boolean,
  npx = false,
): string {
  const hint = buildUpdateHint(channel, npx);
  if (interactive) {
    const versionMessage = `Update available: ${current} → ${latest}`;
    const contentWidth = Math.max(versionMessage.length, hint.length);
    const innerWidth = contentWidth + 4;
    const horizontal = "─".repeat(innerWidth);
    const emptyLine = `│${" ".repeat(innerWidth)}│`;

    const frameLines = [
      `╭${horizontal}╮`,
      emptyLine,
      `│  ${versionMessage}${" ".repeat(contentWidth - versionMessage.length)}  │`,
      `│  ${hint}${" ".repeat(contentWidth - hint.length)}  │`,
      emptyLine,
      `╰${horizontal}╯`,
    ];
    return `\n${frameLines.map((line) => pc.yellow(line)).join("\n")}\n`;
  }

  const agentAction = hint[0].toLowerCase() + hint.slice(1);
  const verifyCommand = npx ? "npx -y @dosu/cli@latest --version" : "dosu --version";
  return (
    `\n[dosu:update] Update available: ${current} → ${latest}\n` +
    `Tell the user Dosu CLI is outdated. After they approve, ${agentAction}, ` +
    `then verify with "${verifyCommand}".\n`
  );
}

function displayNotice(current: string, latest: string): void {
  console.error(
    buildUpdateNotice(
      current,
      latest,
      INSTALL_CHANNEL,
      process.stderr.isTTY === true,
      isNpxInvocation(),
    ),
  );
}

/**
 * Check for updates — awaited from the preAction hook.
 *
 * Reads cached version info and displays a notice if outdated.
 * Waits up to one second for a refresh if the cache is stale (>6 h), so short-lived
 * commands cannot exit before a newly discovered update is shown.
 */
export async function checkForUpdates(): Promise<void> {
  try {
    const cache = readCache();
    const isStale = !cache || Date.now() - cache.lastCheck > CHECK_INTERVAL_MS;
    if (!isStale) {
      if (isNewerVersion(cache.latestVersion, VERSION)) {
        displayNotice(VERSION, cache.latestVersion);
      }
      return;
    }

    // Prefer the freshly fetched version; fall back to a valid stale cache when offline.
    const latest = await fetchLatestVersion();
    const latestKnownVersion = latest ?? cache?.latestVersion ?? VERSION;
    // Always update lastCheck to throttle retries (even on failure)
    writeCache({
      lastCheck: Date.now(),
      latestVersion: latestKnownVersion,
    });
    if (latest) {
      logger.debug("update-check", `Cached latest version: ${latest}`);
    }
    if (isNewerVersion(latestKnownVersion, VERSION)) {
      displayNotice(VERSION, latestKnownVersion);
    }
  } catch (err) {
    logger.error("update-check", `Update check failed: ${err}`);
  }
}
