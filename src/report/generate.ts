/**
 * Assemble the knowledge report: fetch the caller's notes from the backend
 * (the single source of truth), attribute each note's investigation stretch
 * against the local session logs, and emit the HTML.
 */

import { basename } from "node:path";
import { type Config, loadConfig } from "../config/config";
import { createProjectDirResolver } from "../sessions/project-dir";
import type { AgentSession } from "../sessions/scan";
import { scanAgentSessions } from "../sessions/scan";
import { loadSyncState, type ShippedSessionRecord } from "../sync/watermark";
import { type FetchedReportNotes, fetchReportNotes } from "./fetch";
import { buildReportHtml } from "./html";
import { attributeRediscovery, digestsForSessions, sessionsToInventory } from "./notes";
import type { ReportNote } from "./types";
import { defaultReportPath, writeAndOpenReport } from "./write";

export interface EmitReportOptions {
  /** Injectable for tests; the default fetches from the backend. */
  notes?: ReportNote[];
  sessions?: AgentSession[];
  /** Injectable for tests; the default reads the ship watermark state. */
  shipped?: ShippedSessionRecord[];
  orgName?: string;
  /** Injectable project-name source for a session; the default resolves the
   * session's real working directory and uses its basename. */
  projectName?: (session: AgentSession) => string | null;
  out?: string;
  open?: boolean;
  openUrl?: (url: string) => Promise<unknown>;
  generatedAt?: Date;
  fetchNotes?: (cfg: Config) => Promise<FetchedReportNotes>;
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

function defaultProjectName(): (session: AgentSession) => string | null {
  const resolver = createProjectDirResolver();
  return (session) => {
    const dir = resolver.resolve(session);
    return dir ? basename(dir) : null;
  };
}

function noteTime(note: ReportNote): number {
  const parsed = Date.parse(note.at ?? "");
  return Number.isNaN(parsed) ? 0 : parsed;
}

export async function emitKnowledgeReport(options: EmitReportOptions = {}): Promise<string> {
  const cfg = loadConfig();
  const fetched = options.notes
    ? { notes: options.notes, truncated: false }
    : await (options.fetchNotes ?? fetchReportNotes)(cfg);
  const notes = [...fetched.notes].sort((a, b) => noteTime(a) - noteTime(b));
  const scanned = options.sessions ?? scanAgentSessions();
  const sessions = sessionsForNotes(notes, scanned);
  const candidates = attributeRediscovery(notes, sessions);
  const inventory = sessionsToInventory(sessions);
  const state = loadSyncState();
  if (inventory.totals && state.total_learning_tokens && !options.sessions) {
    // All-time distilled baseline, when this machine has studied.
    inventory.totals.learning_tokens = state.total_learning_tokens;
  }
  const projectName = options.projectName ?? defaultProjectName();
  const projects = [
    ...new Set(
      sessions
        .map((s) => projectName(s) ?? s.project)
        .filter((name): name is string => Boolean(name)),
    ),
  ];
  const html = buildReportHtml({
    inventory,
    candidates,
    orgName: options.orgName ?? cfg.active_account?.target?.org_name ?? "Your team",
    projects,
    truncated: fetched.truncated,
    generatedAt: options.generatedAt,
    digests: digestsForSessions(sessions),
    shipped: options.shipped ?? state.ship?.shipped_sessions ?? [],
  });
  return writeAndOpenReport({
    html,
    out: options.out ?? defaultReportPath(),
    open: options.open,
    openUrl: options.openUrl,
  });
}
