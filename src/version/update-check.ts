/**
 * Non-blocking version update checker.
 *
 * Uses a "check now, display next run" pattern:
 * 1. On startup, reads a cached latest version from disk.
 * 2. If the cached version is newer than the running version, prints a notice to stderr.
 * 3. If the cache is stale (>24 h), fires a background fetch to the npm registry (not awaited).
 */

import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import pc from "picocolors";
import { getConfigDir } from "../config/config";
import { logger } from "../debug/logger";
import { VERSION } from "./version";

const CACHE_FILENAME = "update-check.json";
const CHECK_INTERVAL_MS = 24 * 60 * 60 * 1000; // 24 hours
const FETCH_TIMEOUT_MS = 5_000;
const REGISTRY_URL = "https://registry.npmjs.org/-/package/@dosu/cli/dist-tags";

interface UpdateCache {
  lastCheck: number;
  latestVersion: string;
}

/** Compare two semver strings. Returns true if `latest` is newer than `current`. */
export function isNewerVersion(latest: string, current: string): boolean {
  const a = latest.split(".").map(Number);
  const b = current.split(".").map(Number);
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
    if (typeof data.lastCheck === "number" && typeof data.latestVersion === "string") {
      return data as UpdateCache;
    }
    return null;
  } catch {
    return null;
  }
}

function writeCache(cache: UpdateCache): void {
  try {
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
    return typeof latest === "string" ? latest : null;
  } catch {
    return null;
  } finally {
    clearTimeout(timeout);
  }
}

function displayNotice(current: string, latest: string): void {
  const msg =
    `\n${pc.yellow(`  Update available: ${current} → ${latest}`)}\n` +
    `${pc.dim('  Run "npm update -g @dosu/cli" or visit https://github.com/dosu-ai/dosu-cli/releases')}\n`;
  console.error(msg);
}

/**
 * Check for updates — called synchronously from the preAction hook.
 *
 * Reads cached version info and displays a notice if outdated.
 * Fires a background fetch if the cache is stale (>24 h).
 */
export function checkForUpdates(): void {
  try {
    const cache = readCache();

    // Display notice if cached latest is newer than running version
    if (cache && isNewerVersion(cache.latestVersion, VERSION)) {
      displayNotice(VERSION, cache.latestVersion);
    }

    // Fire background fetch if cache is missing or stale
    const isStale = !cache || Date.now() - cache.lastCheck > CHECK_INTERVAL_MS;
    if (isStale) {
      fetchLatestVersion()
        .then((latest) => {
          if (latest) {
            writeCache({ lastCheck: Date.now(), latestVersion: latest });
            logger.debug("update-check", `Cached latest version: ${latest}`);
          }
        })
        .catch((err) => {
          logger.error("update-check", `Background fetch failed: ${err}`);
        });
    }
  } catch (err) {
    logger.error("update-check", `Update check failed: ${err}`);
  }
}
