/**
 * Standalone Analytics screen: all-time mining numbers from local sync state
 * plus backend page analytics (top cited, recently updated) for the active
 * Library. Pure render/reduce functions wired to injectable IO.
 */

import pc from "picocolors";
import { createTypedClient, type TypedClient } from "../client/trpc";
import { loadConfig } from "../config/config";
import { formatTokenCount, getSyncStatus, type SyncStatus } from "../sync/status";
import type { SyncState } from "../sync/watermark";
import { enterAltScreen } from "./alt-screen";
import { breadcrumb, frameTopMargin } from "./layout";
import { parseKeys } from "./menu";

const ESC = String.fromCharCode(27);
const HIDE_CURSOR = `${ESC}[?25l`;
const SHOW_CURSOR = `${ESC}[?25h`;
const CTRL_C = String.fromCharCode(3);
const KEY_UP = `${ESC}[A`;
const KEY_DOWN = `${ESC}[B`;
const CURSOR_HOME = `${ESC}[H`;
const CLEAR_BELOW = `${ESC}[0J`;
const CLEAR_EOL = `${ESC}[K`;

/** Relaxed poll: analytics only move when a mining batch completes. */
const ANALYTICS_VIEW_POLL_MS = 1000;

/** How many report lines fit on screen at once (the scroll window). */
export const ANALYTICS_VIEW_LINES = 12;

export type AnalyticsViewAction = "back" | "up" | "down" | "none";

/** q / esc / ctrl-c go back, ↑/↓ (or k/j) scroll the report. */
export function reduceAnalyticsViewKey(key: string): AnalyticsViewAction {
  if (key === "q" || key === ESC || key === CTRL_C) return "back";
  if (key === KEY_UP || key === "k") return "up";
  if (key === KEY_DOWN || key === "j") return "down";
  return "none";
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

/**
 * The report body. "Investigation distilled" is the tokens the mined
 * investigations originally cost to learn; future reads reuse that.
 */
export function analyticsRows(state: SyncState, pageStats: PageStats | null = null): string[] {
  const minedTotal = state.total_mined ?? 0;
  const notes = state.total_notes ?? 0;
  const tokens = state.total_learning_tokens ?? 0;
  const label = (text: string) => text.padEnd(26);
  const rows: string[] = [];
  if (minedTotal > 0 || notes > 0) {
    rows.push(`${label("Sessions mined")}${minedTotal}`, `${label("Suggested pages")}${notes}`);
    if (tokens > 0) {
      rows.push(`${label("Investigation distilled")}${formatTokenCount(tokens)} tokens`);
    }
    const byProject = new Map<string, number>();
    for (const record of state.mined_sessions ?? []) {
      const key = record.project ?? "(unknown)";
      byProject.set(key, (byProject.get(key) ?? 0) + 1);
    }
    if (byProject.size > 0) {
      rows.push("", "Mined by project (recent history)");
      const top = [...byProject.entries()].sort((a, b) => b[1] - a[1]).slice(0, 8);
      for (const [project, count] of top) {
        rows.push(`${label(clip(project, 24))}${count}`);
      }
    }
  }
  if (pageStats && pageStats.topCited.length > 0) {
    rows.push(...(rows.length > 0 ? [""] : []), `Top cited pages (${TOP_CITED_DAYS}d)`);
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

/** Render the full analytics block, anchored to the content column's left edge. */
export function renderAnalyticsFrame(
  state: SyncState,
  scroll: number,
  pageStats: PageStats | null = null,
): string {
  const rows = analyticsRows(state, pageStats);
  const { visible, above, below } = windowReport(rows, scroll);
  const listRows =
    visible.length > 0
      ? visible.map((row) => pc.dim(row))
      : [pc.dim("No analytics yet. They appear after the first mining run.")];

  const scrollParts: string[] = [];
  if (above > 0) scrollParts.push(`\u2191 ${above} earlier`);
  if (below > 0) scrollParts.push(`\u2193 ${below} more`);

  const lines = [
    breadcrumb(["Home", "Analytics"]),
    "",
    ...listRows,
    ...(scrollParts.length > 0 ? [pc.dim(scrollParts.join(" \u00B7 "))] : []),
    "",
    pc.dim("\u2191\u2193 scroll \u00B7 esc back"),
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

  let scroll = 0;
  let status = getStatus();
  let pageStats: PageStats | null = null;
  let closed = false;

  // Same painting discipline as the Activity view; identical frames skip the write.
  let lastFrame: string | null = null;
  const draw = () => {
    status = getStatus();
    const frame = renderAnalyticsFrame(status.state, scroll, pageStats);
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
    if (closed || !stats) return;
    pageStats = stats;
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
        if (action === "up") {
          if (scroll > 0) {
            scroll -= 1;
            draw();
          }
        } else if (action === "down") {
          const maxScroll = Math.max(
            0,
            analyticsRows(status.state, pageStats).length - ANALYTICS_VIEW_LINES,
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
