/**
 * Assemble the knowledge report: fetch the caller's notes from the backend
 * (the single source of truth), attribute each note's investigation stretch
 * against the local session logs, and emit the HTML.
 */

import { type Config, loadConfig } from "../config/config";
import type { AgentSession } from "../sessions/scan";
import { scanAgentSessions } from "../sessions/scan";
import { loadSyncState } from "../sync/watermark";
import { fetchReportNotes } from "./fetch";
import { buildReportHtml } from "./html";
import { attributeRediscovery, digestsForSessions, sessionsToInventory } from "./notes";
import type { ReportNote } from "./types";
import { defaultReportPath, writeAndOpenReport } from "./write";

export interface EmitReportOptions {
  /** Injectable for tests; the default fetches from the backend. */
  notes?: ReportNote[];
  sessions?: AgentSession[];
  orgName?: string;
  repo?: string;
  branch?: string;
  out?: string;
  open?: boolean;
  openUrl?: (url: string) => Promise<unknown>;
  generatedAt?: Date;
  fetchNotes?: (cfg: Config) => Promise<ReportNote[]>;
}

/** Only the sessions the notes actually reference: traces and inventory must
 * never widen to unrelated local history when attribution is missing. */
function sessionsForNotes(
  notes: readonly ReportNote[],
  sessions: readonly AgentSession[],
): AgentSession[] {
  const ids = new Set(notes.map((n) => n.transcript_id).filter((id): id is string => Boolean(id)));
  return sessions.filter((s) => ids.has(s.id));
}

function noteTime(note: ReportNote): number {
  const parsed = Date.parse(note.at ?? "");
  return Number.isNaN(parsed) ? 0 : parsed;
}

export async function emitKnowledgeReport(options: EmitReportOptions = {}): Promise<string> {
  const cfg = loadConfig();
  const notes = [...(options.notes ?? (await (options.fetchNotes ?? fetchReportNotes)(cfg)))].sort(
    (a, b) => noteTime(a) - noteTime(b),
  );
  const scanned = options.sessions ?? scanAgentSessions();
  const sessions = sessionsForNotes(notes, scanned);
  const candidates = attributeRediscovery(notes, sessions);
  const inventory = sessionsToInventory(sessions);
  const state = loadSyncState();
  if (inventory.totals && state.total_learning_tokens && !options.sessions) {
    // All-time distilled baseline, when this machine has mined.
    inventory.totals.learning_tokens = state.total_learning_tokens;
  }
  const html = buildReportHtml({
    inventory,
    candidates,
    orgName: options.orgName ?? cfg.active_account?.target?.org_name ?? "Your team",
    repo: options.repo ?? notes.find((n) => n.repo)?.repo,
    branch: options.branch ?? notes.find((n) => n.branch)?.branch,
    generatedAt: options.generatedAt,
    digests: digestsForSessions(sessions),
  });
  return writeAndOpenReport({
    html,
    out: options.out ?? defaultReportPath(),
    open: options.open,
    openUrl: options.openUrl,
  });
}
