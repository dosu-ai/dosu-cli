/** Cached version update checker: reads a cached latest version on startup, prints a stderr
 * notice when newer, and refreshes a stale (>6 h) cache with a bounded one-second wait. */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import pc from "picocolors";
import { getConfigDir } from "../config/config";
import { logger } from "../debug/logger";
import { brand } from "../setup/styles";
import { centerBlock, visibleWidth } from "../tui/layout";
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

/** Spaces between the frame and the widest content line. */
const BOX_PADDING = 3;

/** Dim the hint but keep its quoted command bright, so the action pops. */
function styleHint(hint: string): string {
  const match = hint.match(/^(.*)("[^"]+")(.*)$/);
  if (!match) return pc.dim(hint);
  const [, before, command, after] = match;
  return [before && pc.dim(before), pc.cyan(command), after && pc.dim(after)]
    .filter(Boolean)
    .join("");
}

export function buildUpdateNotice(
  current: string,
  latest: string,
  channel: string,
  interactive: boolean,
  npx = false,
  width: number = process.stderr.columns ?? 80,
): string {
  const hint = buildUpdateHint(channel, npx);
  if (interactive) {
    const content = [
      `Update available: ${pc.dim(current)} ${pc.dim("→")} ${pc.bold(brand(latest))}`,
      styleHint(hint),
    ];
    const innerWidth = Math.max(...content.map(visibleWidth)) + BOX_PADDING * 2;

    // Center each line inside the frame, then the frame in the terminal, so
    // the notice lines up with the centered TUI welcome screen beneath it.
    const framed = (line: string): string => {
      const pad = innerWidth - visibleWidth(line);
      const left = Math.floor(pad / 2);
      return `${pc.yellow("│")}${" ".repeat(left)}${line}${" ".repeat(pad - left)}${pc.yellow("│")}`;
    };
    const box = [
      pc.yellow(`╭${"─".repeat(innerWidth)}╮`),
      framed(""),
      ...content.map(framed),
      framed(""),
      pc.yellow(`╰${"─".repeat(innerWidth)}╯`),
    ];
    return `\n${centerBlock(box, width).join("\n")}\n`;
  }

  const agentAction = hint[0].toLowerCase() + hint.slice(1);
  const verifyCommand = npx ? "npx -y @dosu/cli@latest --version" : "dosu --version";
  return (
    `\n[dosu:update] Update available: ${current} → ${latest}\n` +
    `Tell the user Dosu CLI is outdated. After they approve, ${agentAction}, ` +
    `then verify with "${verifyCommand}".\n`
  );
}

/** The update the cache already knows about, if any, for surfaces (the TUI welcome banner)
 * that render the notice themselves instead of printing the boxed stderr notice. */
export function getAvailableUpdate(): string | null {
  const cache = readCache();
  return cache && isNewerVersion(cache.latestVersion, VERSION) ? cache.latestVersion : null;
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

/** Check for updates, awaited from the preAction hook. With `notify: false` the check still
 * refreshes the cache but prints nothing; the TUI welcome banner shows the update itself. */
export async function checkForUpdates(options: { notify?: boolean } = {}): Promise<void> {
  const notify = options.notify ?? true;
  try {
    const cache = readCache();
    const isStale = !cache || Date.now() - cache.lastCheck > CHECK_INTERVAL_MS;
    if (!isStale) {
      if (notify && isNewerVersion(cache.latestVersion, VERSION)) {
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
    if (notify && isNewerVersion(latestKnownVersion, VERSION)) {
      displayNotice(VERSION, latestKnownVersion);
    }
  } catch (err) {
    logger.error("update-check", `Update check failed: ${err}`);
  }
}
