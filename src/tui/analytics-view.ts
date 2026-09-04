/**
 * The Analytics report shown as a tab of the Activity view: all-time mining
 * numbers from local sync state plus backend page analytics (top cited,
 * recently updated) for the active Library.
 */

import { createTypedClient, type TypedClient } from "../client/trpc";
import { loadConfig } from "../config/config";
import { formatTokenCount } from "../sync/status";
import type { SyncState } from "../sync/watermark";

/** Default scroll-window height for windowReport. */
const ANALYTICS_VIEW_LINES = 12;

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
export function loadPageStatsFromConfig(): Promise<PageStats | null> {
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
