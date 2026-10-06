/** Assemble the memory report: the sessions this install shipped in the period, looked up in
 * Dosu memory, aggregated, and written as one HTML page. */

import { basename } from "node:path";
import { type Config, loadConfig } from "../config/config";
import { getBackendURL, getWebAppURL, isAbsoluteHttpUrl } from "../config/constants";
import { unmungeSlug } from "../sessions/project-dir";
import { loadSyncState, type ShippedSessionRecord, type SyncState } from "../sync/watermark";
import { type FetchReportSessionsOptions, fetchReportSessions } from "./fetch";
import { buildReportHtml } from "./html";
import { buildReport } from "./model";
import type { Report, ReportSession } from "./types";
import { defaultReportPath, type WriteReportOptions, writeAndOpenReport } from "./write";

export const DEFAULT_REPORT_DAYS = 30;

export interface ReportOptions {
  days?: number;
  /** Injectable boundaries, for tests. */
  loadConfig?: () => Config;
  loadState?: () => SyncState;
  backendUrl?: string;
  appUrl?: string;
  now?: () => Date;
  fetchSessions?: (
    records: ShippedSessionRecord[],
    options: FetchReportSessionsOptions,
  ) => Promise<ReportSession[]>;
  /** Shipped project label → display name; defaults to the folder name behind a path slug. */
  projectName?: (project: string) => string;
}

/** Claude Code records a session's project as its path with slashes turned into hyphens
 * (`-Users-me-dosu-backend`); show the folder name when the path still exists. */
function defaultProjectName(project: string): string {
  const dir = project.startsWith("-") ? unmungeSlug(project) : null;
  return dir ? basename(dir) : project;
}

export async function buildKnowledgeReport(options: ReportOptions = {}): Promise<Report> {
  const cfg = (options.loadConfig ?? loadConfig)();
  if (cfg.mode === "oss") {
    throw new Error("The memory report needs Dosu cloud: OSS mode has no Dosu memory.");
  }
  const target = cfg.active_account?.target;
  if (!target?.api_key || !target.org_id) {
    throw new Error("Not connected to a Dosu organization. Run `dosu setup` first.");
  }
  const backendUrl = options.backendUrl ?? getBackendURL();
  if (!isAbsoluteHttpUrl(backendUrl)) throw new Error("No Dosu backend URL is configured.");

  const days = options.days ?? DEFAULT_REPORT_DAYS;
  const now = (options.now ?? (() => new Date()))();
  const since = now.getTime() - days * 24 * 60 * 60 * 1000;
  const records = ((options.loadState ?? loadSyncState)().shipped_sessions ?? []).filter(
    (record) => Date.parse(record.at) >= since,
  );
  const sessions =
    records.length === 0
      ? []
      : await (options.fetchSessions ?? fetchReportSessions)(records, {
          apiKey: target.api_key,
          orgId: target.org_id,
          backendUrl,
        });
  const projectName = options.projectName ?? defaultProjectName;
  return buildReport({
    generatedAt: now.toISOString(),
    days,
    orgName: target.org_name ?? "Your team",
    appUrl: (options.appUrl ?? getWebAppURL()).replace(/\/$/, ""),
    sessions: sessions.map((s) => (s.project ? { ...s, project: projectName(s.project) } : s)),
  });
}

export interface EmitReportOptions extends ReportOptions {
  out?: string;
  open?: boolean;
  write?: (options: WriteReportOptions) => Promise<string>;
  openUrl?: (url: string) => Promise<unknown>;
}

/** The cross-session report, or — for a single session, where there is nothing to compare —
 * that session's own page in Dosu. */
export type EmitReportResult =
  | { kind: "report"; path: string; sessions: number }
  | { kind: "session"; url: string };

export async function emitKnowledgeReport(
  options: EmitReportOptions = {},
): Promise<EmitReportResult> {
  const report = await buildKnowledgeReport(options);
  if (report.sessions.length === 1) {
    const url = `${report.appUrl}/memories/sessions/${encodeURIComponent(report.sessions[0].sessionId)}`;
    if (options.open !== false) {
      await (options.openUrl ?? (async (target: string) => (await import("open")).default(target)))(
        url,
      );
    }
    return { kind: "session", url };
  }
  const path = await (options.write ?? writeAndOpenReport)({
    html: buildReportHtml(report),
    out: options.out ?? defaultReportPath(),
    open: options.open,
  });
  return { kind: "report", path, sessions: report.sessions.length };
}
