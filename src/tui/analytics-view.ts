/**
 * Standalone Analytics screen: tabbed report over all-time mining numbers
 * from local sync state (Overview, Projects) plus backend page analytics
 * (Pages). Pure render/reduce functions wired to injectable IO.
 */

import pc from "picocolors";
import { createTypedClient, type TypedClient } from "../client/trpc";
import { loadConfig } from "../config/config";
import { formatTokenCount, getSyncStatus, type SyncStatus } from "../sync/status";
import type { SyncState } from "../sync/watermark";
import { enterAltScreen } from "./alt-screen";
import { breadcrumb, contentWidth, frameTopMargin, tabStrip } from "./layout";
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

/** Relaxed poll: analytics only move when a mining batch completes. */
const ANALYTICS_VIEW_POLL_MS = 1000;

/** How many report lines fit on screen at once (the scroll window). */
export const ANALYTICS_VIEW_LINES = 12;

export type AnalyticsViewTab = "overview" | "projects" | "pages";

/** Tab order for cycling; ← walks it backwards. */
const ANALYTICS_VIEW_TABS: readonly AnalyticsViewTab[] = ["overview", "projects", "pages"];

export type AnalyticsViewAction = "back" | "tab" | "tab-back" | "up" | "down" | "none";

/** q/esc/ctrl-c back, tab/→ and ← cycle tabs, ↑/↓ (or k/j) scroll. */
export function reduceAnalyticsViewKey(key: string): AnalyticsViewAction {
  if (key === "q" || key === ESC || key === CTRL_C) return "back";
  if (key === "\t" || key === KEY_RIGHT) return "tab";
  if (key === KEY_LEFT) return "tab-back";
  if (key === KEY_UP || key === "k") return "up";
  if (key === KEY_DOWN || key === "j") return "down";
  return "none";
}

/** The next tab in cycle order; `delta` -1 walks backwards. */
export function cycleAnalyticsTab(tab: AnalyticsViewTab, delta: 1 | -1 = 1): AnalyticsViewTab {
  const index = ANALYTICS_VIEW_TABS.indexOf(tab);
  const next = (index + delta + ANALYTICS_VIEW_TABS.length) % ANALYTICS_VIEW_TABS.length;
  return ANALYTICS_VIEW_TABS[next];
}

function clip(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, max - 1)}\u2026`;
}

/** How many pages each "Top ..." section shows. */
const TOP_PAGES_LIMIT = 5;

/** The cited-pages window, in days. */
const TOP_CITED_DAYS = 30;

/** Backend page analytics: freshest pages and most-cited pages. */
export interface PageStats {
  /** Most recently updated pages (the backend lists newest-updated first). */
  topUpdated: Array<{ title: string; updated_at: string }>;
  /** Pages cited most often in Dosu answers over the last TOP_CITED_DAYS. */
  topCited: Array<{ title: string; citation_count: number }>;
}

/**
 * Fetch page analytics for the Library behind `spaceId`; null when it has no
 * knowledge store. Fail-open per section (old backends lack `page.topCited`).
 */
export async function fetchPageStats(
  client: TypedClient,
  spaceId: string,
): Promise<PageStats | null> {
  const store = await client.knowledgeStore.getBySpaceId.query({ space_id: spaceId });
  if (!store) return null;

  const updated = client.page.listWithTags.query({
    knowledge_store_id: store.id,
    limit: TOP_PAGES_LIMIT,
    offset: 0,
  });
  const cited = client.page.topCited
    .query({ knowledge_store_id: store.id, days: TOP_CITED_DAYS, limit: TOP_PAGES_LIMIT })
    .catch(() => []); // old backend without the procedure: skip the section
  const [updatedResult, citedResult] = await Promise.all([updated, cited]);

  return {
    topUpdated: updatedResult.data.map((page) => ({
      title: page.title || "(untitled)",
      updated_at: page.updated_at,
    })),
    topCited: citedResult.map((row) => ({
      title: row.title || "(untitled)",
      citation_count: row.citation_count,
    })),
  };
}

/** The default loader: stored login + target, failing open to "no section". */
function loadPageStatsFromConfig(): Promise<PageStats | null> {
  try {
    const cfg = loadConfig();
    const spaceId = cfg.active_account?.target?.space_id;
    if (!spaceId) return Promise.resolve(null);
    return fetchPageStats(createTypedClient(cfg), spaceId).catch(() => null);
  } catch {
    return Promise.resolve(null); // signed out, unreadable config, …
  }
}

const label = (text: string) => text.padEnd(26);

/**
 * Overview tab: the all-time totals. "Investigation distilled" is the tokens
 * the mined investigations originally cost to learn; future reads reuse that.
 */
export function overviewRows(state: SyncState): string[] {
  const minedTotal = state.total_mined ?? 0;
  const notes = state.total_notes ?? 0;
  const tokens = state.total_learning_tokens ?? 0;
  if (minedTotal === 0 && notes === 0) return [];
  const rows = [`${label("Sessions mined")}${minedTotal}`, `${label("Suggested pages")}${notes}`];
  if (tokens > 0) {
    rows.push(`${label("Investigation distilled")}${formatTokenCount(tokens)} tokens`);
  }
  return rows;
}

/** Projects tab: recent mined-session history bucketed by project. */
export function projectRows(state: SyncState): string[] {
  const byProject = new Map<string, number>();
  for (const record of state.mined_sessions ?? []) {
    const key = record.project ?? "(unknown)";
    byProject.set(key, (byProject.get(key) ?? 0) + 1);
  }
  return [...byProject.entries()]
    .sort((a, b) => b[1] - a[1])
    .map(([project, count]) => `${label(clip(project, 24))}${count}`);
}

/** Pages tab: the backend page sections, once the stats have landed. */
export function pageRows(pageStats: PageStats | null): string[] {
  const rows: string[] = [];
  if (pageStats && pageStats.topCited.length > 0) {
    rows.push(`Top cited pages (${TOP_CITED_DAYS}d)`);
    for (const row of pageStats.topCited) {
      rows.push(`${label(clip(row.title, 24))}${row.citation_count}`);
    }
  }
  if (pageStats && pageStats.topUpdated.length > 0) {
    rows.push(...(rows.length > 0 ? [""] : []), "Recently updated pages");
    for (const row of pageStats.topUpdated) {
      rows.push(`${label(clip(row.title, 24))}${row.updated_at.slice(0, 10)}`);
    }
  }
  return rows;
}

/** Top-anchored scroll window: a report reads top-down, unlike the feeds. */
export function windowReport(
  lines: readonly string[],
  scroll: number,
  height: number = ANALYTICS_VIEW_LINES,
): { visible: string[]; above: number; below: number } {
  const clamped = Math.max(0, Math.min(scroll, Math.max(0, lines.length - height)));
  return {
    visible: lines.slice(clamped, clamped + height),
    above: clamped,
    below: Math.max(0, lines.length - clamped - height),
  };
}

/** The rows the given tab displays. */
export function analyticsTabRows(
  tab: AnalyticsViewTab,
  state: SyncState,
  pageStats: PageStats | null,
): string[] {
  if (tab === "overview") return overviewRows(state);
  if (tab === "projects") return projectRows(state);
  return pageRows(pageStats);
}

/** Render the full analytics block, anchored to the content column's left edge. */
export function renderAnalyticsFrame(
  state: SyncState,
  tab: AnalyticsViewTab,
  scroll: number,
  pageStats: PageStats | null = null,
  /** True while the backend page-stats fetch hasn't settled yet. */
  pagesPending = false,
  width: number = contentWidth(),
): string {
  const rows = analyticsTabRows(tab, state, pageStats);
  const { visible, above, below } = windowReport(rows, scroll);
  const empty =
    tab === "overview"
      ? "No analytics yet. They appear after the first mining run."
      : tab === "projects"
        ? "No per-project history yet. It fills in as sessions are mined."
        : pagesPending
          ? "Loading page analytics..."
          : "No page analytics yet.";
  const listRows = visible.length > 0 ? visible.map((row) => pc.dim(row)) : [pc.dim(empty)];

  const scrollParts: string[] = [];
  if (above > 0) scrollParts.push(`\u2191 ${above} earlier`);
  if (below > 0) scrollParts.push(`\u2193 ${below} more`);

  const lines = [
    breadcrumb(["Home", "Analytics"], width),
    "",
    // Cells, not spread: equal-width side-by-side tabs read as one table.
    ...tabStrip(
      [
        ["overview", "Overview"],
        ["projects", "Projects"],
        ["pages", "Pages"],
      ],
      tab,
      width,
      { spread: false },
    ),
    ...listRows,
    ...(scrollParts.length > 0 ? [pc.dim(scrollParts.join(" \u00B7 "))] : []),
    "",
    pc.dim("tab switch \u00B7 \u2191\u2193 scroll \u00B7 esc back"),
  ];
  return lines.join("\n");
}

export interface AnalyticsViewIO {
  input?: NodeJS.ReadStream;
  output?: NodeJS.WriteStream;
  /** Lock/watermark state without the log read; called every poll. */
  getStatus?: () => SyncStatus;
  /** Injectable page analytics fetch for tests; defaults to the backend. */
  loadPageStats?: () => Promise<PageStats | null>;
  pollMs?: number;
}

/**
 * Show the analytics screen until the user goes back. Resolves immediately
 * when stdin isn't interactive.
 */
export function runAnalyticsView(io: AnalyticsViewIO = {}): Promise<void> {
  const input = io.input ?? process.stdin;
  const output = io.output ?? process.stdout;
  if (!input.isTTY) return Promise.resolve();

  const getStatus = io.getStatus ?? (() => getSyncStatus({ readLog: () => "" }));
  const loadPageStats = io.loadPageStats ?? loadPageStatsFromConfig;
  const pollMs = io.pollMs ?? ANALYTICS_VIEW_POLL_MS;

  let tab: AnalyticsViewTab = "overview";
  let scroll = 0;
  let status = getStatus();
  let pageStats: PageStats | null = null;
  let pagesPending = true;
  let closed = false;

  // Same painting discipline as the Activity view; identical frames skip the write.
  let lastFrame: string | null = null;
  const draw = () => {
    status = getStatus();
    const width = Math.min(contentWidth(output.columns ?? 80), (output.columns ?? 80) - 1);
    const frame = renderAnalyticsFrame(status.state, tab, scroll, pageStats, pagesPending, width);
    if (frame === lastFrame) return;
    lastFrame = frame;
    // Fixed top margin; +1 matches the home banner's leading blank line.
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

  const leaveAltScreen = enterAltScreen(output);
  output.write(HIDE_CURSOR);
  draw();

  // Backend page analytics land after the local numbers paint; fails open to null.
  loadPageStats().then((stats) => {
    if (closed) return;
    pageStats = stats;
    pagesPending = false;
    draw();
  });

  return new Promise((resolve) => {
    const wasRaw = input.isRaw ?? false;
    input.setRawMode?.(true);
    input.resume();

    const timer = setInterval(draw, pollMs);
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
        const action = reduceAnalyticsViewKey(key);
        if (action === "back") {
          finish();
          return;
        }
        if (action === "tab" || action === "tab-back") {
          tab = cycleAnalyticsTab(tab, action === "tab" ? 1 : -1);
          scroll = 0;
          draw();
        } else if (action === "up") {
          if (scroll > 0) {
            scroll -= 1;
            draw();
          }
        } else if (action === "down") {
          const maxScroll = Math.max(
            0,
            analyticsTabRows(tab, status.state, pageStats).length - ANALYTICS_VIEW_LINES,
          );
          if (scroll < maxScroll) {
            scroll += 1;
            draw();
          }
        }
      }
    };
    input.on("data", onData);
  });
}
