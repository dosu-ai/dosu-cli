/** Assemble the memory report: the sessions this install shipped in the period, looked up in
 * Dosu memory, aggregated, and written as one HTML page. */

import { type Config, loadConfig } from "../config/config";
import { getBackendURL, getWebAppURL, isAbsoluteHttpUrl } from "../config/constants";
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
  return buildReport({
    generatedAt: now.toISOString(),
    days,
    orgName: target.org_name ?? "Your team",
    appUrl: (options.appUrl ?? getWebAppURL()).replace(/\/$/, ""),
    sessions,
  });
}

export interface EmitReportOptions extends ReportOptions {
  out?: string;
  open?: boolean;
  write?: (options: WriteReportOptions) => Promise<string>;
}

export async function emitKnowledgeReport(options: EmitReportOptions = {}): Promise<string> {
  const report = await buildKnowledgeReport(options);
  return (options.write ?? writeAndOpenReport)({
    html: buildReportHtml(report),
    out: options.out ?? defaultReportPath(),
    open: options.open,
  });
}
