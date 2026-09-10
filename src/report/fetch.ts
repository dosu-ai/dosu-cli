/**
 * Fetch the caller's knowledge notes from the backend — the single source of
 * truth for the report. Online-only by design: a report without the backend
 * would have nothing honest to show, so failures surface as actionable errors
 * instead of a silently empty page.
 */

import type { Config } from "../config/config";
import type { ReportNote } from "./types";

export const REPORT_NOTES_LIMIT = 500;

export async function fetchReportNotes(cfg: Config): Promise<ReportNote[]> {
  const orgId = cfg.active_account?.target?.org_id;
  if (!orgId || !cfg.active_account?.session.access_token) {
    throw new Error("Not signed in. Run `dosu setup` to connect an account first.");
  }
  // Dynamic so report-free CLI paths never pay for the tRPC client.
  const { createTypedClient } = await import("../client/trpc");
  const client = createTypedClient(cfg);
  const { notes } = await client.notes.listMine.query({
    org_id: orgId,
    limit: REPORT_NOTES_LIMIT,
  });
  return notes.map((note) => ({
    title: note.title,
    content: note.body,
    at: note.created_at,
    ...(note.transcript_id ? { transcript_id: note.transcript_id } : {}),
    ...(note.repo ? { repo: note.repo } : {}),
    ...(note.branch ? { branch: note.branch } : {}),
  }));
}
