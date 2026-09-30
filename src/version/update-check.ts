/** Cached version update checker: reads a cached latest version on startup, starts a background
 * install and prints a stderr notice when newer, and refreshes a stale (>6 h) cache with a
 * bounded one-second wait. */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import pc from "picocolors";
import { getConfigDir } from "../config/config";
import { logger } from "../debug/logger";
import { brand } from "../setup/styles";
import { centerBlock, visibleWidth } from "../tui/layout";
import { startAutoUpdate } from "./auto-update";
import { INSTALL_CHANNEL, isNpxInvocation, type ReleaseTag, releaseTag, VERSION } from "./version";

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

/** Semver precedence, prerelease identifiers included: `0.63.0-beta.2` is newer than
 * `-beta.1`, and `0.63.0` is newer than any of its prereleases. `isNewerVersion` ignores
 * prereleases, which is right for its format-change callers but would leave a beta install
 * blind to the next beta. */
export function isNewerRelease(candidate: string, current: string): boolean {
  if (isNewerVersion(candidate, current)) return true;
  if (isNewerVersion(current, candidate)) return false;
  const pre = (v: string) => /^[^-+]+-([^+]+)/.exec(v)?.[1]?.split(".");
  const a = pre(candidate);
  const b = pre(current);
  if (!a) return b !== undefined;
  if (!b) return false;
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    if (a[i] === undefined) return false;
    if (b[i] === undefined) return true;
    if (a[i] === b[i]) continue;
    const an = /^\d+$/.test(a[i]) ? Number(a[i]) : Number.NaN;
    const bn = /^\d+$/.test(b[i]) ? Number(b[i]) : Number.NaN;
    if (!Number.isNaN(an) && !Number.isNaN(bn)) return an > bn;
    if (!Number.isNaN(an)) return false;
    if (!Number.isNaN(bn)) return true;
    return a[i] > b[i];
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

/** Fetch the newest version published under `tag` (this build's channel by default). */
export async function fetchLatestVersion(tag: ReleaseTag = releaseTag()): Promise<string | null> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    const resp = await fetch(REGISTRY_URL, { signal: controller.signal });
    if (!resp.ok) return null;
    const data = (await resp.json()) as Record<string, string>;
    const latest = data[tag];
    return isValidVersion(latest) ? latest : null;
  } catch {
    return null;
  } finally {
    clearTimeout(timeout);
  }
}

export function buildUpdateHint(channel: string, npx = false): string {
  if (channel === "npm" && npx) {
    return `Use "npx -y @dosu/cli@${releaseTag()}" for the next Dosu command`;
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

function framedNotice(content: string[], width: number): string {
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

function versionArrow(current: string, latest: string): string {
  return `${pc.dim(current)} ${pc.dim("→")} ${pc.bold(brand(latest))}`;
}

/** Shown while a background install is running: nobody needs to act, so an agent is told not
 * to interrupt the user about it. */
export function buildAutoUpdateNotice(
  current: string,
  latest: string,
  interactive: boolean,
  width: number = process.stderr.columns ?? 80,
): string {
  if (interactive) {
    return framedNotice(
      [
        `Updating Dosu: ${versionArrow(current, latest)}`,
        pc.dim("Installing in the background; your next command uses it"),
      ],
      width,
    );
  }
  return (
    `\n[dosu:update] Installing Dosu ${latest} in the background (running ${current}). ` +
    "The next Dosu command uses it; no action needed.\n"
  );
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
    return framedNotice(
      [`Update available: ${versionArrow(current, latest)}`, styleHint(hint)],
      width,
    );
  }

  const agentAction = hint[0].toLowerCase() + hint.slice(1);
  const verifyCommand = npx ? `npx -y @dosu/cli@${releaseTag()} --version` : "dosu --version";
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
  return cache && isNewerRelease(cache.latestVersion, VERSION) ? cache.latestVersion : null;
}

/** Start (or join) a background install of this channel's newest version, then tell the person what is happening:
 * that it is installing, or, when this copy cannot update itself, how to do it by hand. */
function handleNewerVersion(latest: string, notify: boolean): void {
  const autoUpdate = startAutoUpdate(latest);
  if (!notify) return;
  const interactive = process.stderr.isTTY === true;
  console.error(
    autoUpdate === "unavailable"
      ? buildUpdateNotice(VERSION, latest, INSTALL_CHANNEL, interactive, isNpxInvocation())
      : buildAutoUpdateNotice(VERSION, latest, interactive),
  );
}

/** Check for updates, awaited from the preAction hook. A newer version starts a background
 * install. With `notify: false` nothing is printed; the TUI welcome banner shows the update. */
export async function checkForUpdates(options: { notify?: boolean } = {}): Promise<void> {
  const notify = options.notify ?? true;
  try {
    const cache = readCache();
    const isStale = !cache || Date.now() - cache.lastCheck > CHECK_INTERVAL_MS;
    if (!isStale) {
      if (isNewerRelease(cache.latestVersion, VERSION)) {
        handleNewerVersion(cache.latestVersion, notify);
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
    if (isNewerRelease(latestKnownVersion, VERSION)) {
      handleNewerVersion(latestKnownVersion, notify);
    }
  } catch (err) {
    logger.error("update-check", `Update check failed: ${err}`);
  }
}
