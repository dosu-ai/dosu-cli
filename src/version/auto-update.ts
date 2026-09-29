/** Default-on background auto-update. When the update check knows a newer release, a detached
 * `dosu upgrade --background` installs it through the package manager that owns this copy. The
 * next command runs the new version, whose first-run checks re-apply skills and MCP entries. */

import { spawn } from "node:child_process";
import {
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
  writeSync,
} from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { getConfigDir } from "../config/config";
import { logger } from "../debug/logger";
import { INSTALL_CHANNEL, isNpxInvocation } from "./version";

const STATE_FILENAME = "auto-update.json";
const LOCK_FILENAME = "auto-update.lock";
/** A background install still holding the lock after this long is presumed dead. */
const LOCK_STALE_MS = 15 * 60 * 1000;
/** A version whose background install already ran (and left us outdated) waits this long. */
const RETRY_INTERVAL_MS = 6 * 60 * 60 * 1000;
const SUPPORTED_CHANNELS = new Set(["npm", "homebrew"]);
const VERSION_PATTERN = /^[0-9A-Za-z.+-]{1,64}$/;

export const AUTO_UPDATE_ENV = "DOSU_DISABLE_AUTOUPDATE";

type Env = Readonly<Record<string, string | undefined>>;

interface AutoUpdateAttempt {
  version: string;
  ok: boolean;
  finishedAt: number;
}

interface AutoUpdateState {
  disabled?: true;
  lastAttempt?: AutoUpdateAttempt;
}

export type AutoUpdateStatus = "started" | "in_progress" | "unavailable";

interface Invocation {
  command: string;
  args: string[];
}

interface StartOptions {
  channel?: string;
  env?: Env;
  now?: number;
  entrypoint?: string;
  execPath?: string;
}

function statePath(): string {
  return join(getConfigDir(), STATE_FILENAME);
}

function lockPath(): string {
  return join(getConfigDir(), LOCK_FILENAME);
}

function isValidVersion(value: unknown): value is string {
  return typeof value === "string" && VERSION_PATTERN.test(value);
}

function readState(): AutoUpdateState {
  try {
    const raw = JSON.parse(readFileSync(statePath(), "utf-8")) as unknown;
    if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return {};
    const data = raw as Record<string, unknown>;
    const state: AutoUpdateState = {};
    if (data.disabled === true) state.disabled = true;
    const last = data.lastAttempt as Record<string, unknown> | undefined;
    if (
      last &&
      isValidVersion(last.version) &&
      typeof last.ok === "boolean" &&
      typeof last.finishedAt === "number"
    ) {
      state.lastAttempt = { version: last.version, ok: last.ok, finishedAt: last.finishedAt };
    }
    return state;
  } catch {
    return {};
  }
}

function writeState(state: AutoUpdateState): boolean {
  try {
    const dir = getConfigDir();
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true, mode: 0o700 });
    writeFileSync(statePath(), `${JSON.stringify(state, null, 2)}\n`, { mode: 0o600 });
    return true;
  } catch {
    return false;
  }
}

function isEnabledFlag(value: string | undefined): boolean {
  if (value === undefined) return false;
  const normalized = value.trim().toLowerCase();
  return normalized !== "" && !["0", "false", "no", "off"].includes(normalized);
}

/** Why auto-update is off, if a person turned it off. The environment variable wins. */
export function autoUpdateDisabledReason(env: Env = process.env): "env" | "settings" | undefined {
  if (isEnabledFlag(env[AUTO_UPDATE_ENV])) return "env";
  if (readState().disabled) return "settings";
  return undefined;
}

/** Auto-update is on by default; this persists the single opt-out. */
export function setAutoUpdateEnabled(enabled: boolean): boolean {
  const state = readState();
  if (enabled) delete state.disabled;
  else state.disabled = true;
  return writeState(state);
}

function canAutoUpdate(channel: string, env: Env): boolean {
  if (env.NODE_ENV === "test" || env.CI || env.DOSU_DEV === "true") return false;
  // npx runs are ephemeral, and standalone binaries have no package manager to update them.
  if (!SUPPORTED_CHANNELS.has(channel) || isNpxInvocation(channel, env)) return false;
  return autoUpdateDisabledReason(env) === undefined;
}

/** How to re-run this same copy of Dosu as a detached background upgrade. */
export function backgroundInvocation(
  channel: string,
  entrypoint: string | undefined = process.argv[1],
  execPath: string = process.execPath,
): Invocation | null {
  const args = ["upgrade", "--background"];
  if (channel === "npm") {
    return entrypoint ? { command: execPath, args: [entrypoint, ...args] } : null;
  }
  // The Homebrew build is a compiled binary: execPath is Dosu itself.
  if (channel === "homebrew") return { command: execPath, args };
  return null;
}

function lockIsFresh(now: number): boolean {
  try {
    return now - statSync(lockPath()).mtimeMs < LOCK_STALE_MS;
  } catch {
    return false;
  }
}

/** Atomically claim the install so concurrent commands never run two package managers. */
function claimLock(version: string, now: number): "claimed" | "held" | "failed" {
  try {
    mkdirSync(getConfigDir(), { recursive: true, mode: 0o700 });
    if (!lockIsFresh(now)) rmSync(lockPath(), { force: true });
    const fd = openSync(lockPath(), "wx", 0o600);
    try {
      writeSync(fd, version);
    } finally {
      closeSync(fd);
    }
    return "claimed";
  } catch (err) {
    return (err as { code?: unknown }).code === "EEXIST" ? "held" : "failed";
  }
}

function releaseLock(): void {
  try {
    rmSync(lockPath(), { force: true });
  } catch {
    // A leftover lock goes stale and is reclaimed.
  }
}

function readLockVersion(): string | undefined {
  try {
    const version = readFileSync(lockPath(), "utf-8").trim();
    return isValidVersion(version) ? version : undefined;
  } catch {
    return undefined;
  }
}

/** Start a detached install of `version` unless one is running, it recently ran, or this copy
 * cannot or should not update itself. Never throws and never blocks on the install. */
export function startAutoUpdate(version: string, options: StartOptions = {}): AutoUpdateStatus {
  const channel = options.channel ?? INSTALL_CHANNEL;
  const env = options.env ?? process.env;
  const now = options.now ?? Date.now();
  try {
    if (!isValidVersion(version) || !canAutoUpdate(channel, env)) return "unavailable";
    if (lockIsFresh(now)) return "in_progress";

    const last = readState().lastAttempt;
    if (last?.version === version && now - last.finishedAt < RETRY_INTERVAL_MS) {
      return "unavailable";
    }

    const invocation = backgroundInvocation(channel, options.entrypoint, options.execPath);
    if (!invocation) return "unavailable";

    const claim = claimLock(version, now);
    if (claim !== "claimed") return claim === "held" ? "in_progress" : "unavailable";

    try {
      const child = spawn(invocation.command, invocation.args, {
        cwd: homedir(),
        detached: true,
        stdio: "ignore",
        windowsHide: true,
        // The install is not a command the person ran; keep it out of command analytics.
        env: { ...env, DOSU_TELEMETRY_DISABLED: "1" },
      });
      child.on("error", releaseLock);
      child.unref();
    } catch (err) {
      releaseLock();
      throw err;
    }
    logger.info("auto-update", `Started background update to ${version}`);
    return "started";
  } catch (err) {
    logger.error("auto-update", `Could not start background update: ${err}`);
    return "unavailable";
  }
}

/** Body of `dosu upgrade --background`: install, record the outcome, release the lock. A failed
 * install surfaces the manual "dosu upgrade" notice until the retry interval passes. */
export function runBackgroundUpgrade(upgrade: () => number, now: () => number = Date.now): number {
  const version = readLockVersion();
  let status = 1;
  try {
    status = upgrade();
  } catch (err) {
    logger.error("auto-update", `Background update threw: ${err}`);
  }
  if (version) {
    const state = readState();
    state.lastAttempt = { version, ok: status === 0, finishedAt: now() };
    writeState(state);
  }
  logger.info("auto-update", `Background update ${status === 0 ? "finished" : "failed"}`);
  releaseLock();
  return status;
}
