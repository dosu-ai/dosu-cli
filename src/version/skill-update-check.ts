/** Non-blocking skill update checker with a "check now, display next run" pattern. Mirrors
 * `update-check.ts` but tracks git SHAs instead of semver versions. */

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

/** Forget which SHA is installed so the update notice stops firing; an empty `installedSha`
 * means "unknown" and keeps `checkForSkillUpdates` quiet until the next install repopulates it. */
export function clearInstalledSha(): void {
  const cache = readSkillCache();
  if (cache) writeSkillCache({ ...cache, installedSha: "" });
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

function displayNotice(): void {
  const msg =
    `\n${pc.yellow("  Dosu skill update available")}\n` +
    `${pc.dim('  Run "dosu skill update" to upgrade')}\n`;
  console.error(msg);
}

/** Check for skill updates, called synchronously from the preAction hook. When `installedSha`
 * is empty, only `latestSha` is refreshed and no notice fires until a later install sets it. */
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
          // Re-read so a concurrent `dosu skill update` that just refreshed
          // installedSha isn't clobbered by our stale closure copy.
          const fresh = readSkillCache();
          writeSkillCache({
            lastCheck: Date.now(),
            latestSha: latest ?? fresh?.latestSha ?? "",
            installedSha: fresh?.installedSha ?? "",
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
