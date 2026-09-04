/**
 * Live Activity screen for the TUI: mining status plus tabs (activity feed,
 * mined history, queued backlog, open sessions, analytics report) and a
 * manual sync trigger. Pure render/reduce functions wired to injectable IO.
 */

import { readFileSync } from "node:fs";
import pc from "picocolors";
import { createLogFollower } from "../debug/follow";
import { logger, stripAnsiCodes } from "../debug/logger";
import { createProjectDirResolver } from "../sessions/project-dir";
import { type AgentSession, scanAgentSessions } from "../sessions/scan";
import { brand } from "../setup/styles";
import { spawnDetachedSelf } from "../sync/detach";
import { getSyncStatus, type SyncStatus } from "../sync/status";
import {
  filterSessionsByProject,
  gateSessions,
  loadSyncState,
  type MinedSessionRecord,
} from "../sync/watermark";
import { enterAltScreen } from "./alt-screen";
import {
  analyticsRows,
  loadPageStatsFromConfig,
  type PageStats,
  windowReport,
} from "./analytics-view";
import {
  breadcrumb,
  centerBlock,
  contentWidth,
  frameTopMargin,
  layoutMargin,
  visibleWidth,
} from "./layout";
import { parseKeys } from "./menu";

const ESC = String.fromCharCode(27);
const HIDE_CURSOR = `${ESC}[?25l`;
const SHOW_CURSOR = `${ESC}[?25h`;
const CTRL_C = String.fromCharCode(3);
const KEY_UP = `${ESC}[A`;
const KEY_DOWN = `${ESC}[B`;
const KEY_RIGHT = `${ESC}[C`;
const KEY_LEFT = `${ESC}[D`;
const CURSOR_HOME = `${ESC}[H`;
const CLEAR_BELOW = `${ESC}[0J`;
const CLEAR_EOL = `${ESC}[K`;

/** How often the view re-checks the lock and polls the log for new lines. */
const ACTIVITY_VIEW_POLL_MS = 500;

/** How many list lines fit on screen at once (the scroll window). */
const ACTIVITY_VIEW_LIST_LINES = 10;

/** How much history each tab keeps in memory for scrolling back. */
export const ACTIVITY_VIEW_BUFFER_LINES = 200;

export type ActivityViewTab = "activity" | "queued" | "open" | "mined" | "analytics";

/** Tab order for cycling; ← walks it backwards. */
const ACTIVITY_VIEW_TABS: readonly ActivityViewTab[] = [
  "activity",
  "mined",
  "queued",
  "open",
  "analytics",
];

export type ActivityViewAction = "back" | "tab" | "tab-back" | "up" | "down" | "sync" | "none";

/** q/esc/ctrl-c back, tab/→ and ← cycle tabs, ↑↓ (or k/j) scroll, s syncs. */
export function reduceActivityViewKey(key: string): ActivityViewAction {
  if (key === "q" || key === ESC || key === CTRL_C) return "back";
  if (key === "\t" || key === KEY_RIGHT) return "tab";
  if (key === KEY_LEFT) return "tab-back";
  if (key === KEY_UP || key === "k") return "up";
  if (key === KEY_DOWN || key === "j") return "down";
  if (key === "s") return "sync";
  return "none";
}

/** The next tab in cycle order; `delta` -1 walks backwards. */
export function cycleTab(tab: ActivityViewTab, delta: 1 | -1 = 1): ActivityViewTab {
  const index = ACTIVITY_VIEW_TABS.indexOf(tab);
  const next = (index + delta + ACTIVITY_VIEW_TABS.length) % ACTIVITY_VIEW_TABS.length;
  return ACTIVITY_VIEW_TABS[next];
}

export type SyncConfirmAction = "start" | "cancel" | "none";

/** Confirmation keys: enter/y/s start, esc/n/q cancel, everything else ignored. */
export function reduceSyncConfirmKey(key: string): SyncConfirmAction {
  if (key === "\r" || key === "\n" || key === "y" || key === "s") return "start";
  if (key === ESC || key === "n" || key === "q" || key === CTRL_C) return "cancel";
  return "none";
}

/**
 * Strip ANSI (clipping mid-sequence would bleed color over the frame),
 * shorten the ISO timestamp to HH:MM:SS, and clip to the view width.
 */
export function formatActivityLine(line: string, width: number): string {
  const compact = stripAnsiCodes(line).replace(
    /^\[(\d{4}-\d{2}-\d{2})T(\d{2}:\d{2}:\d{2})[^\]]*\]/,
    (_match, _date, time: string) => time,
  );
  if (compact.length <= width) return compact;
  return `${compact.slice(0, Math.max(0, width - 1))}\u2026`;
}

/** Keep only [sync]/[miner] log lines (level tag stripped), newest `max`. */
export function appendSyncActivity(
  buffer: readonly string[],
  chunk: string,
  max: number = ACTIVITY_VIEW_BUFFER_LINES,
): string[] {
  const fresh = chunk
    .split("\n")
    .filter((line) => line.includes("[sync]") || line.includes("[miner]"))
    .map((line) => line.replace(/ \[(DEBUG|INFO|WARN|ERROR)\]/, ""));
  return [...buffer, ...fresh].slice(-max);
}

function clip(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, max - 1)}\u2026`;
}

/** Mined-history record as a row ("cursor    09-02 23:00  dosu  abc"), same columns as Queued. */
export function formatMinedRow(record: MinedSessionRecord): string {
  const match = record.at.match(/^\d{4}-(\d{2}-\d{2})T(\d{2}:\d{2})/);
  const stamp = match ? `${match[1]} ${match[2]}` : record.at;
  const slash = record.session.indexOf("/");
  const harness = slash > 0 ? record.session.slice(0, slash) : "-";
  const id = slash > 0 ? record.session.slice(slash + 1) : record.session;
  const project = clip(record.project ?? "-", 28);
  return `${harness.padEnd(8)}  ${stamp}  ${project}  ${clip(id, 24)}`;
}

/** Queued session as a row: agent, updated (UTC), project, session id. */
export function formatQueuedRow(session: AgentSession): string {
  const stamp = session.updated.replace("T", " ").slice(5, 16);
  const project = clip(session.project ?? "-", 28);
  return `${session.harness.padEnd(8)}  ${stamp}  ${project}  ${clip(session.id, 24)}`;
}

/** The scanned session backlog the Queued and Open tabs display. */
interface SessionBacklog {
  /** Gated (quiet, not yet mined) sessions, oldest first. */
  queued: AgentSession[];
  /** Sessions still inside the quiet period — queued once they go silent. */
  open: AgentSession[];
}

/**
 * Full-history scan of the gated backlog (what a "sync now" would mine),
 * oldest first. Never throws; a failed scan reads as an empty backlog.
 */
function defaultListBacklog(): SessionBacklog {
  try {
    const state = loadSyncState();
    let sessions = scanAgentSessions({});
    if (state.project_filter?.length) {
      const resolver = createProjectDirResolver();
      sessions = filterSessionsByProject(sessions, state.project_filter, resolver.resolve);
      resolver.flush();
    }
    const gate = gateSessions(sessions, state.watermark);
    return { queued: gate.ready.reverse(), open: gate.open.reverse() };
  } catch {
    return { queued: [], open: [] };
  }
}

/**
 * Slice a scrollback window out of `lines`: `scroll` counts lines up from
 * the newest (bottom), clamped so the window never runs off either end.
 */
export function windowList(
  lines: readonly string[],
  scroll: number,
  height: number = ACTIVITY_VIEW_LIST_LINES,
): { visible: string[]; above: number; below: number } {
  const clamped = Math.max(0, Math.min(scroll, Math.max(0, lines.length - height)));
  const end = lines.length - clamped;
  const start = Math.max(0, end - height);
  return { visible: lines.slice(start, end), above: start, below: clamped };
}

export interface SyncBacklog {
  ready: number;
  inFlight: number;
}

/** Backlog counts from a "[sync] gate: N ready, M in flight" log line. */
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

/** Within-batch mining progress, folded live from the miner's log traces. */
export interface RunProgress {
  /** Batch size from the latest "[sync] mining N of M" marker. */
  batch: number;
  /** Distinct session ids the miner has opened so far this batch. */
  read: Set<string>;
  /** write_knowledge calls traced so far this batch. */
  notes: number;
}

/**
 * Fold a log chunk into within-batch progress. total_mined only commits per
 * batch, so the bar steps off the miner's tool traces instead; a settle line
 * clears the fold so stale steps never double-count against the counters.
 */
export function foldRunProgress(progress: RunProgress | null, chunk: string): RunProgress | null {
  let current = progress;
  for (const line of chunk.split("\n")) {
    const start = line.match(/\[sync\] mining (\d+) of \d+ ready sessions/);
    if (start) {
      current = { batch: Number.parseInt(start[1], 10), read: new Set(), notes: 0 };
      continue;
    }
    if (/\[sync\] (mined \d+ sessions|mining failed|mining skipped)/.test(line)) {
      current = null;
      continue;
    }
    if (!current) continue;
    // Pagination and re-reads repeat an id; the set collapses them.
    const read = line.match(/\[miner\] \[agent\] → mcp__sessions__read_session .*?"id":"([^"]+)"/);
    if (read) {
      current.read.add(read[1]);
      continue;
    }
    if (line.includes("[miner] [agent] → mcp__dosu__write_knowledge")) {
      current.notes += 1;
    }
  }
  return current;
}

function localTime(iso: string): string {
  const parsed = new Date(iso);
  return Number.isNaN(parsed.getTime()) ? iso : parsed.toLocaleTimeString();
}

function statusLine(status: SyncStatus): string {
  if (status.running) {
    const since = status.startedAt ? ` \u00B7 since ${localTime(status.startedAt)}` : "";
    const pid = status.pid !== undefined ? ` (pid ${status.pid})` : "";
    return `\u26CF\uFE0F ${pc.bold(brand("Mining sessions..."))}${pc.dim(`${pid}${since}`)}`;
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

/**
 * Drain-progress bar for an active run. `done` must be run-scoped (lifetime
 * total_mined pins the bar at ~100%); the caller subtracts the run baseline.
 */
export function progressLine(done: number, ready: number, width: number, notes = 0): string | null {
  const total = done + ready;
  if (total <= 0) return null;
  // Leave room for the " done/total mined · NN% · NN suggested pages" suffix.
  const cells = Math.max(10, Math.min(30, width - 44));
  const ratio = Math.max(0, Math.min(1, done / total));
  const filled = Math.min(cells, Math.round(ratio * cells));
  const bar = brand("\u2588".repeat(filled)) + pc.dim("\u2591".repeat(cells - filled));
  const pct = Math.floor(ratio * 100);
  const suffix = notes > 0 ? ` \u00B7 ${notes} suggested page${notes === 1 ? "" : "s"}` : "";
  return `${bar} ${done}/${total} mined \u00B7 ${pct}%${suffix}`;
}

/**
 * The tab strip: one row of labels over a rule, with the active segment in
 * bold brand color and a heavier rule mark (visible even without color).
 */
export function tabBar(
  tab: ActivityViewTab,
  queuedCount: number,
  openCount: number,
  minedCount: number,
  width: number,
): string[] {
  const labels: Array<[ActivityViewTab, string]> = [
    ["activity", "Activity"],
    ["mined", `Mined (${minedCount})`],
    ["queued", `Queued (${queuedCount})`],
    ["open", `Open (${openCount})`],
    ["analytics", "Analytics"],
  ];
  // Space-between across the frame width; narrow frames fall back to a
  // minimum gap and let the row run long.
  const GAP_MIN = 3;
  const totalLen = labels.reduce((sum, [, label]) => sum + label.length, 0);
  const slots = labels.length - 1;
  const spare = Math.max(GAP_MIN * slots, width - totalLen);
  const baseGap = Math.floor(spare / slots);
  const bonus = spare % slots; // first `bonus` gaps get one extra column
  let row = "";
  let col = 0;
  let activeStart = 0;
  let activeLen = 0;
  labels.forEach(([id, label], i) => {
    if (i > 0) {
      const gap = baseGap + (i <= bonus ? 1 : 0);
      row += " ".repeat(gap);
      col += gap;
    }
    if (id === tab) {
      activeStart = col;
      activeLen = label.length;
      row += brand(pc.bold(label));
    } else {
      row += pc.dim(label);
    }
    col += label.length;
  });
  const tail = Math.max(0, width - activeStart - activeLen);
  const rule =
    pc.dim("\u2500".repeat(activeStart)) +
    brand("\u2501".repeat(activeLen)) +
    pc.dim("\u2500".repeat(tail));
  return [row, rule];
}

/**
 * Frame width: the centered column with symmetric margins, minus one column
 * so a full-width painted line never trips the terminal's auto-wrap.
 */
export function activityWidth(columns: number): number {
  return Math.max(20, columns - 2 * layoutMargin(columns) - 1);
}

/**
 * Word-wrap to `width` with hanging indent; unwrapped lines would hard-wrap
 * at the screen edge, outside the centered layout's margin.
 */
export function wrapLine(text: string, width: number, indent = "  "): string[] {
  const out: string[] = [];
  let line = "";
  for (const word of text.split(" ")) {
    if (line !== "" && line.length + 1 + word.length > width) {
      out.push(line);
      line = indent + word;
    } else {
      line = line === "" ? word : `${line} ${word}`;
    }
  }
  if (line !== "") out.push(line);
  return out;
}

export interface ActivityViewPane {
  tab: ActivityViewTab;
  /** Lines scrolled up from the newest entry (0 = pinned to bottom). */
  scroll: number;
  /** Pending "s" press: the start-mining confirmation popup is up. */
  confirm?: boolean;
}

const DEFAULT_PANE: ActivityViewPane = { tab: "activity", scroll: 0 };

/**
 * The "start mining?" confirmation: a rounded-border box over the footer
 * saying what a run would mine right now, shown while `pane.confirm` is set.
 */
export function confirmBox(
  queuedCount: number,
  backlog: SyncBacklog | null,
  width: number,
): string[] {
  const inFlight =
    backlog && backlog.inFlight > 0
      ? ` (+${backlog.inFlight} open, mined once ${backlog.inFlight === 1 ? "it goes" : "they go"} quiet)`
      : "";
  const scope =
    queuedCount > 0
      ? `${queuedCount} session${queuedCount === 1 ? "" : "s"} queued${inFlight} \u00B7 runs in the background`
      : `queue empty${inFlight} \u00B7 a run would only pick up sessions that finish from here`;
  const maxInner = Math.max(20, Math.min(width, contentWidth()) - 4);
  const rows = [
    // Bare pickaxe, no U+FE0F: xterm.js advances one column for the emoji
    // pair while visibleWidth counts two, skewing this row's right border.
    `\u26CF ${pc.bold(brand("Start mining now?"))}`,
    ...wrapLine(scope, maxInner, "").map((line) => pc.dim(line)),
    "",
    `${pc.bold("enter")} start \u00B7 ${pc.bold("esc")} cancel`,
  ];
  const inner = Math.min(maxInner, Math.max(...rows.map(visibleWidth)));
  const pad = (row: string) => row + " ".repeat(Math.max(0, inner - visibleWidth(row)));
  return [
    pc.dim(`\u256D${"\u2500".repeat(inner + 2)}\u256E`),
    ...rows.map((row) => `${pc.dim("\u2502")} ${pad(row)} ${pc.dim("\u2502")}`),
    pc.dim(`\u2570${"\u2500".repeat(inner + 2)}\u256F`),
  ];
}

/** Render the full sync-status block, centered within `width` columns. */
export function renderActivityFrame(
  status: SyncStatus,
  activity: readonly string[],
  width: number,
  backlog: SyncBacklog | null = null,
  pane: ActivityViewPane = DEFAULT_PANE,
  queued: readonly AgentSession[] = [],
  /** Lifetime total_mined when the current run started; see progressLine. */
  minedBeforeRun = 0,
  /** Live (still-active) sessions for the Open tab. */
  open: readonly AgentSession[] = [],
  /** Within-batch step progress folded from the miner's log traces. */
  runProgress: RunProgress | null = null,
  /** Backend page analytics for the Analytics tab; null while loading. */
  pageStats: PageStats | null = null,
): string {
  const mined = status.state.watermark
    ? `Mined sessions up to ${localTime(status.state.watermark)}`
    : "Nothing mined yet";
  // Queue and open-session counts live in the tab bar, not a header line.
  const queueDetail: string[] = [];
  if (status.backoffUntil) {
    queueDetail.push(`retrying after ${localTime(status.backoffUntil)}`);
  }

  // Run-scoped drain progress: batch commits advance it, and within a batch
  // the miner's per-session steps do, so a one-batch queue still shows motion.
  let progress: string | null = null;
  if (status.running && backlog) {
    const minedDelta = Math.max(0, (status.state.total_mined ?? 0) - minedBeforeRun);
    // Distinct-opened minus the in-flight one, shifting ready → done rather
    // than growing the total (the gate only re-logs when a batch commits).
    const stepDone = runProgress
      ? Math.min(Math.max(0, runProgress.read.size - 1), runProgress.batch - 1, backlog.ready)
      : 0;
    progress = progressLine(
      minedDelta + stepDone,
      Math.max(0, backlog.ready - stepDone),
      width,
      runProgress?.notes ?? 0,
    );
  }

  // A gateway refusal (consent off, credit limit) explains an Idle-with-
  // backlog view; the message is prose and easily outruns the frame, so wrap.
  const refusal = !status.running && status.state.last_refusal;
  const refusalLines = refusal
    ? wrapLine(`! Mining paused: ${refusal.message} (${localTime(refusal.at)})`, width).map(
        (line) => pc.yellow(line),
      )
    : [];

  // Every list clips to the frame width so no row runs past the tab rule.
  const minedRows = (status.state.mined_sessions ?? []).map((record) =>
    formatActivityLine(formatMinedRow(record), width),
  );
  const queuedRows = queued.map((session) => formatActivityLine(formatQueuedRow(session), width));
  const openRows = open.map((session) => formatActivityLine(formatQueuedRow(session), width));
  const source =
    pane.tab === "activity"
      ? activity.map((line) => formatActivityLine(line, width))
      : pane.tab === "queued"
        ? queuedRows
        : pane.tab === "open"
          ? openRows
          : pane.tab === "analytics"
            ? analyticsRows(status.state, pageStats).map((row) => formatActivityLine(row, width))
            : minedRows;
  // Pre-history runs only advanced the watermark, so mining may have
  // happened without leaving records — say so instead of denying it.
  const emptyMined = status.state.watermark
    ? "No sessions recorded yet. History starts with the next mining run."
    : "No mined sessions yet.";
  const empty =
    pane.tab === "activity"
      ? "No sync activity in the log yet."
      : pane.tab === "queued"
        ? "Queue empty. Finished agent sessions appear here."
        : pane.tab === "open"
          ? "No open sessions. Live agent sessions sit here until they go quiet."
          : pane.tab === "analytics"
            ? "No analytics yet. They appear after the first mining run."
            : emptyMined;
  // The feeds pin to the newest entry; the analytics report reads top-down.
  const { visible, above, below } =
    pane.tab === "analytics"
      ? windowReport(source, pane.scroll, ACTIVITY_VIEW_LIST_LINES)
      : windowList(source, pane.scroll);
  const listRows = visible.length > 0 ? visible.map((row) => pc.dim(row)) : [pc.dim(empty)];

  const scrollParts: string[] = [];
  if (above > 0) scrollParts.push(`\u2191 ${above} earlier`);
  if (below > 0) scrollParts.push(`\u2193 ${below} ${pane.tab === "analytics" ? "more" : "newer"}`);

  const lines = [
    breadcrumb(["Home", "Activity"], width),
    "",
    statusLine(status),
    pc.dim(mined),
    ...(queueDetail.length > 0
      ? wrapLine(queueDetail.join(" \u00B7 "), width).map((line) => pc.dim(line))
      : []),
    ...(progress ? [progress] : []),
    ...refusalLines,
    "",
    ...tabBar(
      pane.tab,
      queued.length,
      open.length,
      status.state.total_mined ?? minedRows.length,
      width,
    ),
    ...listRows,
    ...(scrollParts.length > 0 ? [pc.dim(scrollParts.join(" \u00B7 "))] : []),
    "",
    // Pressing s swaps the key legend for the centered confirmation dialog.
    ...(pane.confirm
      ? centerBlock(confirmBox(queued.length, backlog, width), width)
      : [
          // "s sync now" only while idle; a live run already holds the lock.
          pc.dim(
            [
              "tab switch",
              "\u2191\u2193 scroll",
              ...(status.running ? [] : ["s sync now"]),
              "esc back",
            ].join(" \u00B7 "),
          ),
        ]),
  ];
  // Left-anchored: centering on each frame's longest line would shove the
  // block sideways on every poll.
  return lines.join("\n");
}

export interface ActivityViewIO {
  input?: NodeJS.ReadStream;
  output?: NodeJS.WriteStream;
  /** Lock/watermark state without the log read; called every poll. */
  getStatus?: () => SyncStatus;
  /** Full debug-log contents; read once to seed activity and backlog. */
  readLog?: () => string;
  /** Incremental log tail; called once with the append handler. */
  createFollower?: (emit: (chunk: string) => void) => { poll(): void };
  /** Spawns a detached background sync; pressing `s` while idle calls this. */
  startSync?: () => boolean;
  /** The scanned backlog for the Queued and Open tabs; re-run when the watermark moves. */
  listBacklog?: () => SessionBacklog;
  /** Backend page analytics for the Analytics tab; defaults to the backend. */
  loadPageStats?: () => Promise<PageStats | null>;
  /** Tab shown on entry; the Analytics menu entry deep-links here. */
  initialTab?: ActivityViewTab;
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
export function runActivityView(io: ActivityViewIO = {}): Promise<void> {
  const input = io.input ?? process.stdin;
  const output = io.output ?? process.stdout;
  if (!input.isTTY) return Promise.resolve();

  const getStatus = io.getStatus ?? (() => getSyncStatus({ readLog: () => "" }));
  const readLog = io.readLog ?? defaultReadLog;
  const createFollower =
    io.createFollower ?? ((emit) => createLogFollower(logger.getLogPath(), emit));
  // Bootstrap mode drains the whole displayed queue, not just one batch.
  const startSync =
    io.startSync ?? (() => spawnDetachedSelf(["knowledge", "sync", "--quiet", "--bootstrap"]));
  const listBacklog = io.listBacklog ?? defaultListBacklog;
  const loadPageStats = io.loadPageStats ?? loadPageStatsFromConfig;
  const pollMs = io.pollMs ?? ACTIVITY_VIEW_POLL_MS;

  const seed = readLog();
  let activity = appendSyncActivity([], seed);
  let backlog = latestBacklog(seed);
  // Seeded from the full log so a view opened mid-run starts at the true step.
  let runProgress = foldRunProgress(null, seed);
  let tab: ActivityViewTab = io.initialTab ?? "activity";
  let scroll = 0;
  let confirmSync = false;
  let closed = false;
  let status = getStatus();

  // Page analytics are a backend call, so fetch once and only when the
  // Analytics tab is actually visited; the result lands via a redraw.
  let pageStats: PageStats | null = null;
  let pageStatsRequested = false;
  const ensurePageStats = () => {
    if (pageStatsRequested) return;
    pageStatsRequested = true;
    loadPageStats().then((stats) => {
      if (closed || !stats) return;
      pageStats = stats;
      draw();
    });
  };
  // Rescan on watermark moves and tab switches, not every poll (a scan
  // stats every local session file).
  let sessions = listBacklog();
  let queuedWatermark = status.state.watermark;

  const follower = createFollower((chunk) => {
    activity = appendSyncActivity(activity, chunk);
    backlog = latestBacklog(chunk) ?? backlog;
    runProgress = foldRunProgress(runProgress, chunk);
  });

  const activeListLength = () => {
    if (tab === "activity") return activity.length;
    if (tab === "queued") return sessions.queued.length;
    if (tab === "open") return sessions.open.length;
    if (tab === "analytics") return analyticsRows(status.state, pageStats).length;
    return (status.state.mined_sessions ?? []).length;
  };

  // Identical frames skip the terminal write entirely (most ticks change nothing).
  let lastFrame: string | null = null;
  // total_mined when the run was first observed, so the bar is run-scoped.
  let minedBeforeRun: number | null = null;
  const draw = () => {
    status = getStatus();
    if (status.running) {
      minedBeforeRun ??= status.state.total_mined ?? 0;
    } else {
      minedBeforeRun = null;
    }
    if (status.state.watermark !== queuedWatermark) {
      queuedWatermark = status.state.watermark;
      sessions = listBacklog();
    }
    // A run starting elsewhere makes the pending confirmation moot.
    if (confirmSync && status.running) confirmSync = false;
    const width = activityWidth(output.columns ?? 80);
    const frame = renderActivityFrame(
      status,
      activity,
      width,
      backlog,
      { tab, scroll, confirm: confirmSync },
      sessions.queued,
      minedBeforeRun ?? 0,
      sessions.open,
      runProgress,
      pageStats,
    );
    if (frame === lastFrame) return;
    lastFrame = frame;
    // Fixed top margin, not vertical centering (which jiggles as the frame's
    // height changes); +1 matches the home banner's leading blank line.
    const blank = `${CLEAR_EOL}\n`.repeat(frameTopMargin(output.rows ?? 24) + 1);
    const painted = frame.replaceAll("\n", `${CLEAR_EOL}\n`) + CLEAR_EOL;
    output.write(`${CURSOR_HOME}${blank}${painted}\n${CLEAR_BELOW}`);
  };

  // A resize moves the layout margin even when the frame string is unchanged.
  const onResize = () => {
    lastFrame = null;
    draw();
  };
  output.on?.("resize", onResize);

  // Full-screen app takeover; nested in the TUI the shared alt-screen
  // refcount keeps the same buffer and the view paints over the menu.
  const leaveAltScreen = enterAltScreen(output);
  output.write(HIDE_CURSOR);
  if (tab === "analytics") ensurePageStats();
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
      closed = true;
      clearInterval(timer);
      output.off?.("resize", onResize);
      input.off("data", onData);
      input.setRawMode?.(wasRaw);
      input.pause();
      leaveAltScreen();
      output.write(SHOW_CURSOR);
      resolve();
    };

    const onData = (chunk: Buffer | string) => {
      for (const key of parseKeys(chunk.toString())) {
        // A pending confirmation captures the keys (esc must not exit the view).
        if (confirmSync) {
          const decision = reduceSyncConfirmKey(key);
          if (decision === "start") {
            confirmSync = false;
            const ok = startSync();
            const note = ok
              ? "[sync] sync requested \u00B7 starting a background run"
              : "[sync] could not start a background run \u00B7 try `dosu knowledge sync`";
            // Immediate feed feedback; the real run's log lines follow.
            activity = appendSyncActivity(
              activity,
              `[${new Date().toISOString()}] [INFO] ${note}\n`,
            );
            draw();
          } else if (decision === "cancel") {
            confirmSync = false;
            draw();
          }
          continue;
        }
        const action = reduceActivityViewKey(key);
        if (action === "back") {
          finish();
          return;
        }
        if (action === "sync") {
          // Ignore while a run is live — it already holds the sync lock.
          if (!status.running) {
            confirmSync = true;
            draw();
          }
        } else if (action === "tab" || action === "tab-back") {
          tab = cycleTab(tab, action === "tab" ? 1 : -1);
          scroll = 0;
          // Rescan on entry: open sessions drain into the queue without the
          // watermark ever moving.
          if (tab === "queued" || tab === "open") sessions = listBacklog();
          if (tab === "analytics") ensurePageStats();
          draw();
        } else if (action === "up" || action === "down") {
          // Feeds pin to the bottom (↑ walks back in time); the analytics
          // report is top-anchored (↓ walks toward the bottom).
          const deeper = tab === "analytics" ? action === "down" : action === "up";
          const maxScroll = Math.max(0, activeListLength() - ACTIVITY_VIEW_LIST_LINES);
          if (deeper && scroll < maxScroll) {
            scroll += 1;
            draw();
          } else if (!deeper && scroll > 0) {
            scroll -= 1;
            draw();
          }
        }
      }
    };
    input.on("data", onData);
  });
}
