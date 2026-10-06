/** Look up each shipped session's lineage in Dosu memory: the same per-session payload the web
 * app's session page renders (`GET /v1/memory/browse/sessions/{id}`), authenticated with the
 * install's API key. Only the caller's own ingests come back; a session ingested under another
 * account reads as private. */

import type { ShippedSessionRecord } from "../sync/watermark";
import type { ReportSession, SessionDetail } from "./types";

/** Parallel lookups; enough to keep a month of sessions quick without hammering the API. */
const DEFAULT_CONCURRENCY = 6;
const TIMEOUT_MS = 30_000;

export interface FetchReportSessionsOptions {
  apiKey: string;
  orgId: string;
  backendUrl: string;
  concurrency?: number;
  fetchImpl?: (url: string, init?: RequestInit) => Promise<Response>;
}

/** Shipped records key sessions as `harness/id`; the backend knows only the id. */
function splitKey(key: string): { harness: string; sessionId: string } {
  const slash = key.indexOf("/");
  return slash > 0
    ? { harness: key.slice(0, slash), sessionId: key.slice(slash + 1) }
    : { harness: "unknown", sessionId: key };
}

/** One record per session: the latest shipment, in first-seen order. */
function latestPerSession(records: readonly ShippedSessionRecord[]): ShippedSessionRecord[] {
  const latest = new Map<string, ShippedSessionRecord>();
  for (const record of records) {
    const seen = latest.get(record.session);
    if (!seen || Date.parse(record.at) > Date.parse(seen.at)) latest.set(record.session, record);
  }
  return [...latest.values()];
}

async function lookup(
  record: ShippedSessionRecord,
  options: FetchReportSessionsOptions,
): Promise<ReportSession> {
  const { harness, sessionId } = splitKey(record.session);
  const base: ReportSession = {
    sessionId,
    harness,
    ...(record.project ? { project: record.project } : {}),
    shippedAt: record.at,
    state: "error",
  };
  const url =
    `${options.backendUrl.replace(/\/$/, "")}/v1/memory/browse/sessions/` +
    `${encodeURIComponent(sessionId)}?org=${encodeURIComponent(options.orgId)}`;
  try {
    const response = await (options.fetchImpl ?? fetch)(url, {
      headers: { "X-Dosu-API-Key": options.apiKey },
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    if (!response.ok) return { ...base, error: `HTTP ${response.status}` };
    const detail = (await response.json()) as SessionDetail;
    // Newest ingest first, as the session page lists them.
    const trace = detail.traces[0];
    if (!trace) return { ...base, state: detail.private_traces > 0 ? "private" : "waiting" };
    return { ...base, state: trace.status === "complete" ? "complete" : "processing", trace };
  } catch (err) {
    return { ...base, error: err instanceof Error ? err.message : String(err) };
  }
}

export async function fetchReportSessions(
  records: readonly ShippedSessionRecord[],
  options: FetchReportSessionsOptions,
): Promise<ReportSession[]> {
  const queue = latestPerSession(records);
  const results: ReportSession[] = new Array(queue.length);
  let next = 0;
  const worker = async () => {
    while (next < queue.length) {
      const index = next++;
      results[index] = await lookup(queue[index], options);
    }
  };
  const workers = Math.min(options.concurrency ?? DEFAULT_CONCURRENCY, queue.length);
  await Promise.all(Array.from({ length: workers }, worker));
  return results;
}
