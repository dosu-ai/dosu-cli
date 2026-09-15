/**
 * Fetch the caller's knowledge notes from the backend — the single source of
 * truth for the report. Online-only by design: a report without the backend
 * would have nothing honest to show, so failures surface as actionable errors
 * instead of a silently empty page.
 */

import type { Config } from "../config/config";
import type { ReportNote } from "./types";

export const REPORT_NOTES_LIMIT = 500;
/** Hard stop against a server that returns cursors forever. */
const REPORT_NOTES_MAX_PAGES = 40;

export interface FetchedReportNotes {
  notes: ReportNote[];
  /** True when the server capped the fetch (a full page with no cursor —
   * a pre-pagination backend) so the report can say it is a window. */
  truncated: boolean;
}

export async function fetchReportNotes(cfg: Config): Promise<FetchedReportNotes> {
  const orgId = cfg.active_account?.target?.org_id;
  if (!orgId || !cfg.active_account?.session.access_token) {
    throw new Error("Not signed in. Run `dosu setup` to connect an account first.");
  }
  // Dynamic so report-free CLI paths never pay for the tRPC client.
  const { createTypedClient } = await import("../client/trpc");
  const client = createTypedClient(cfg);
  const notes: ReportNote[] = [];
  let cursor: string | undefined;
  let truncated = false;
  for (let page = 0; page < REPORT_NOTES_MAX_PAGES; page++) {
    const result = await client.notes.listMine.query({
      org_id: orgId,
      limit: REPORT_NOTES_LIMIT,
      ...(cursor ? { cursor } : {}),
    });
    notes.push(
      ...result.notes.map((note) => ({
        title: note.title,
        content: note.body,
        at: note.created_at,
        ...(note.transcript_id ? { transcript_id: note.transcript_id } : {}),
        ...(note.repo ? { repo: note.repo } : {}),
        ...(note.branch ? { branch: note.branch } : {}),
      })),
    );
    cursor = result.next_cursor;
    if (!cursor) {
      // A pre-pagination server never sends a cursor; a full page then means
      // older notes exist that this fetch cannot reach.
      truncated = result.notes.length === REPORT_NOTES_LIMIT;
      break;
    }
    if (page === REPORT_NOTES_MAX_PAGES - 1) truncated = true;
  }
  return { notes, truncated };
}
