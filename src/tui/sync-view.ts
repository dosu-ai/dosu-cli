/**
 * Live knowledge-sync status screen for the TUI.
 *
 * Shows whether a mining run holds the sync lock right now, when things
 * were last mined, and tails the debug log's [sync]/[miner] lines as they
 * land — so a user can watch a run progress without leaving `dosu`.
 *
 * Follows the menu.ts pattern: pure render/reduce functions the tests can
 * drive without a TTY, and a `runSyncView` that wires them to (injectable)
 * streams, a status source, and a log follower.
 */

import { readFileSync } from "node:fs";
import pc from "picocolors";
import { createLogFollower } from "../debug/follow";
import { logger } from "../debug/logger";
import { brand } from "../setup/styles";
import { getSyncStatus, type SyncStatus } from "../sync/status";
import { centerBlock, contentWidth } from "./layout";
import { parseKeys } from "./menu";

const ESC = String.fromCharCode(27);
const HIDE_CURSOR = `${ESC}[?25l`;
const SHOW_CURSOR = `${ESC}[?25h`;
const CTRL_C = String.fromCharCode(3);
/**
 * The view takes over the terminal like a full-screen app (Claude Code,
 * less, vim): enter the alternate screen buffer and draw from the top row;
 * leaving it restores the previous terminal contents untouched.
 */
export const ALT_SCREEN_ENTER = `${ESC}[?1049h`;
export const ALT_SCREEN_EXIT = `${ESC}[?1049l`;
const CURSOR_HOME = `${ESC}[H`;
const CLEAR_BELOW = `${ESC}[0J`;

/** How often the view re-checks the lock and polls the log for new lines. */
export const SYNC_VIEW_POLL_MS = 500;

/** How many activity lines the view keeps on screen. */
export const SYNC_VIEW_ACTIVITY_LINES = 10;

export type SyncViewAction = "back" | "none";

/** Map one key press onto the view: q / esc / ctrl-c go back. */
export function reduceSyncViewKey(key: string): SyncViewAction {
  if (key === "q" || key === ESC || key === CTRL_C) return "back";
  return "none";
}

/**
 * Compact one debug-log activity line for display: the ISO timestamp
 * becomes a local HH:MM:SS, and the result is clipped to the view width.
 */
export function formatActivityLine(line: string, width: number): string {
  const compact = line.replace(
    /^\[(\d{4}-\d{2}-\d{2})T(\d{2}:\d{2}:\d{2})[^\]]*\]/,
    (_match, _date, time: string) => time,
  );
  if (compact.length <= width) return compact;
  return `${compact.slice(0, Math.max(0, width - 1))}\u2026`;
}

/**
 * Fold a raw appended log chunk into the activity buffer, keeping only
 * [sync]/[miner] lines (level tag stripped) and the newest `max` entries.
 */
export function appendSyncActivity(
  buffer: readonly string[],
  chunk: string,
  max: number = SYNC_VIEW_ACTIVITY_LINES,
): string[] {
  const fresh = chunk
    .split("\n")
    .filter((line) => line.includes("[sync]") || line.includes("[miner]"))
    .map((line) => line.replace(/ \[(DEBUG|INFO|WARN|ERROR)\]/, ""));
  return [...buffer, ...fresh].slice(-max);
}

export interface SyncBacklog {
  ready: number;
  inFlight: number;
}

/**
 * Extract the backlog counts from a pipeline gate log line, e.g.
 * "[…] [sync] gate: 44 ready, 1 in flight (watermark …)". Every sync run
 * (including each bootstrap drain round) logs one, so the latest line is a
 * live backlog counter the view gets for free — no session rescan needed.
 */
export function parseGateLine(line: string): SyncBacklog | null {
  const match = line.match(/\[sync\] gate: (\d+) ready, (\d+) in flight/);
  if (!match) return null;
  return { ready: Number.parseInt(match[1], 10), inFlight: Number.parseInt(match[2], 10) };
}

/** The latest backlog counts mentioned anywhere in `text`, or null. */
export function latestBacklog(text: string): SyncBacklog | null {
  let latest: SyncBacklog | null = null;
  for (const line of text.split("\n")) {
    const parsed = parseGateLine(line);
    if (parsed) latest = parsed;
  }
  return latest;
}

function localTime(iso: string): string {
  const parsed = new Date(iso);
  return Number.isNaN(parsed.getTime()) ? iso : parsed.toLocaleTimeString();
}

function statusLine(status: SyncStatus): string {
  if (status.running) {
    const since = status.startedAt ? ` \u00B7 since ${localTime(status.startedAt)}` : "";
    const pid = status.pid !== undefined ? ` (pid ${status.pid})` : "";
    return `${brand("\u25CF")} ${pc.bold("Mining now")}${pc.dim(`${pid}${since}`)}`;
  }
  if (status.staleLock) {
    return `${pc.yellow("\u25CB")} ${pc.bold("Not running")} ${pc.dim(
      "\u00B7 a previous run exited without cleaning up",
    )}`;
  }
  return `${pc.dim("\u25CB")} ${pc.bold("Idle")} ${pc.dim(
    "\u00B7 hooks mine new sessions automatically",
  )}`;
}

/** Render the full sync-status block, centered within `width` columns. */
export function renderSyncFrame(
  status: SyncStatus,
  activity: readonly string[],
  width: number,
  backlog: SyncBacklog | null = null,
): string {
  const mined = status.state.watermark
    ? `Mined sessions up to ${localTime(status.state.watermark)}`
    : "Nothing mined yet";
  const detail = [mined];
  if (backlog) {
    // inFlight = sessions with recent activity, skipped until they go quiet.
    const inFlight =
      backlog.inFlight > 0 ? ` (+${backlog.inFlight} open, queued when they finish)` : "";
    detail.push(
      backlog.ready > 0 ? `${backlog.ready} sessions queued${inFlight}` : `queue empty${inFlight}`,
    );
  }
  if (status.backoffUntil) {
    detail.push(`retrying after ${localTime(status.backoffUntil)}`);
  }

  const activityRows =
    activity.length > 0
      ? activity.map((line) => pc.dim(formatActivityLine(line, width)))
      : [pc.dim("No sync activity in the log yet.")];

  const lines = [
    pc.bold("Knowledge sync"),
    "",
    statusLine(status),
    pc.dim(detail.join(" \u00B7 ")),
    "",
    ...activityRows,
    "",
    pc.dim("updates live \u00B7 esc back"),
  ];
  return centerBlock(lines, width).join("\n");
}

export interface SyncViewIO {
  input?: NodeJS.ReadStream;
  output?: NodeJS.WriteStream;
  /** Lock/watermark state without the log read; called every poll. */
  getStatus?: () => SyncStatus;
  /** Full debug-log contents; read once to seed activity and backlog. */
  readLog?: () => string;
  /** Incremental log tail; called once with the append handler. */
  createFollower?: (emit: (chunk: string) => void) => { poll(): void };
  pollMs?: number;
}

function defaultReadLog(): string {
  try {
    return readFileSync(logger.getLogPath(), "utf-8");
  } catch {
    return "";
  }
}

/**
 * Show the live sync-status screen until the user goes back. Resolves
 * immediately when stdin isn't interactive.
 */
export function runSyncView(io: SyncViewIO = {}): Promise<void> {
  const input = io.input ?? process.stdin;
  const output = io.output ?? process.stdout;
  if (!input.isTTY) return Promise.resolve();

  const getStatus = io.getStatus ?? (() => getSyncStatus({ readLog: () => "" }));
  const readLog = io.readLog ?? defaultReadLog;
  const createFollower =
    io.createFollower ?? ((emit) => createLogFollower(logger.getLogPath(), emit));
  const pollMs = io.pollMs ?? SYNC_VIEW_POLL_MS;

  const width = contentWidth(output.columns ?? 80);
  const seed = readLog();
  let activity = appendSyncActivity([], seed);
  let backlog = latestBacklog(seed);
  const follower = createFollower((chunk) => {
    activity = appendSyncActivity(activity, chunk);
    backlog = latestBacklog(chunk) ?? backlog;
  });

  // Redraws home the cursor, repaint the frame, and clear whatever the
  // previous (possibly taller) frame left below — no scrollback churn.
  const draw = () => {
    const frame = renderSyncFrame(getStatus(), activity, width, backlog);
    output.write(`${CURSOR_HOME}\n${frame}\n${CLEAR_BELOW}`);
  };

  output.write(ALT_SCREEN_ENTER + HIDE_CURSOR);
  draw();

  return new Promise((resolve) => {
    const wasRaw = input.isRaw ?? false;
    input.setRawMode?.(true);
    input.resume();

    const timer = setInterval(() => {
      follower.poll();
      draw();
    }, pollMs);
    // Never keep the process alive just to refresh the screen.
    timer.unref?.();

    const finish = () => {
      clearInterval(timer);
      input.off("data", onData);
      input.setRawMode?.(wasRaw);
      input.pause();
      // Leaving the alternate screen restores the menu exactly as it was.
      output.write(ALT_SCREEN_EXIT + SHOW_CURSOR);
      resolve();
    };

    const onData = (chunk: Buffer | string) => {
      for (const key of parseKeys(chunk.toString())) {
        if (reduceSyncViewKey(key) === "back") {
          finish();
          return;
        }
      }
    };
    input.on("data", onData);
  });
}
