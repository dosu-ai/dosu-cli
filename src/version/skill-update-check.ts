/**
 * Non-blocking skill update checker.
 *
 * Uses a "check now, display next run" pattern:
 * 1. On startup, reads a cached latest skill SHA from disk.
 * 2. If the cached latest SHA differs from the installed SHA, prints a notice to stderr.
 * 3. If the cache is stale (>24 h), fires a background fetch to the GitHub API (not awaited).
 *
 * Mirrors `update-check.ts` but tracks git SHAs instead of semver versions.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import pc from "picocolors";
import { getConfigDir } from "../config/config";
import { logger } from "../debug/logger";
import { VERSION } from "./version";

const CACHE_FILENAME = "skill-update-check.json";
const CHECK_INTERVAL_MS = 24 * 60 * 60 * 1000; // 24 hours
const FETCH_TIMEOUT_MS = 5_000;
const GITHUB_API_URL = "https://api.github.com/repos/dosu-ai/dosu-skill/commits/HEAD";

export interface SkillUpdateCache {
  lastCheck: number;
  latestSha: string;
  installedSha: string;
}

function getCachePath(): string {
  return join(getConfigDir(), CACHE_FILENAME);
}

export function readSkillCache(): SkillUpdateCache | null {
  try {
    const path = getCachePath();
    if (!existsSync(path)) return null;
    const data = JSON.parse(readFileSync(path, "utf-8"));
    if (
      typeof data.lastCheck === "number" &&
      typeof data.latestSha === "string" &&
      typeof data.installedSha === "string"
    ) {
      return data as SkillUpdateCache;
    }
    return null;
  } catch {
    return null;
  }
}

export function writeSkillCache(cache: SkillUpdateCache): void {
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

/** Fetch the latest commit SHA from the dosu-skill GitHub repo. */
export async function fetchLatestSha(): Promise<string | null> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    const resp = await fetch(GITHUB_API_URL, {
      signal: controller.signal,
      headers: {
        "User-Agent": `dosu-cli/${VERSION}`,
        Accept: "application/vnd.github+json",
      },
    });
    if (!resp.ok) return null;
    const data = (await resp.json()) as Record<string, unknown>;
    const sha = data.sha;
    return typeof sha === "string" ? sha : null;
  } catch {
    return null;
  } finally {
    clearTimeout(timeout);
  }
}

/**
 * Refresh the installedSha in the cache to match the current latest upstream SHA.
 * Called after a successful `dosu skill install` or `dosu skill update`.
 *
 * On fetch failure we write a cache with empty installedSha only if no cache exists —
 * otherwise we leave the existing cache alone so later invocations can retry.
 */
export async function refreshInstalledSha(): Promise<void> {
  const sha = await fetchLatestSha();
  if (!sha) {
    logger.debug("skill-update-check", "Failed to fetch latest SHA during refresh");
    return;
  }
  writeSkillCache({
    lastCheck: Date.now(),
    latestSha: sha,
    installedSha: sha,
  });
  logger.debug("skill-update-check", `Refreshed installedSha=${sha}`);
}

function displayNotice(): void {
  const msg =
    `\n${pc.yellow("  Dosu skill update available")}\n` +
    `${pc.dim('  Run "dosu skill update" to upgrade')}\n`;
  console.error(msg);
}

/**
 * Check for skill updates — called synchronously from the preAction hook.
 *
 * Reads cached SHA info and displays a notice if the latest differs from installed.
 * Fires a background fetch if the cache is stale (>24 h).
 *
 * Graceful degradation: if `installedSha` is empty (e.g., user installed skill before
 * this feature shipped), we only refresh `latestSha` and wait for the next install/update
 * to populate `installedSha`.
 */
export function checkForSkillUpdates(): void {
  try {
    const cache = readSkillCache();

    // Display notice only when we know both SHAs and they differ
    if (cache?.installedSha && cache.latestSha && cache.latestSha !== cache.installedSha) {
      displayNotice();
    }

    // Fire background fetch if cache is missing or stale
    const isStale = !cache || Date.now() - cache.lastCheck > CHECK_INTERVAL_MS;
    if (isStale) {
      fetchLatestSha()
        .then((latest) => {
          // Always update lastCheck to throttle retries (even on failure)
          writeSkillCache({
            lastCheck: Date.now(),
            latestSha: latest ?? cache?.latestSha ?? "",
            installedSha: cache?.installedSha ?? "",
          });
          if (latest) {
            logger.debug("skill-update-check", `Cached latest SHA: ${latest}`);
          }
        })
        .catch(
          /* v8 ignore next -- fetchLatestSha never rejects */ (err) => {
            logger.error("skill-update-check", `Background fetch failed: ${err}`);
          },
        );
    }
  } catch (err) {
    logger.error("skill-update-check", `Skill update check failed: ${err}`);
  }
}
