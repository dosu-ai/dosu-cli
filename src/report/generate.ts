/**
 * Assemble inventory + candidates from a mining run (or persisted notes)
 * and emit the skill-identical HTML report.
 */

import { type Config, loadConfig } from "../config/config";
import type { AgentSession } from "../sessions/scan";
import { scanAgentSessions } from "../sessions/scan";
import { loadSyncState } from "../sync/watermark";
import { fetchRemoteNotes, mergeRemoteNotes } from "./backfill";
import { correlateRemoteNotes } from "./correlate";
import { buildReportHtml } from "./html";
import { attributeRediscovery, digestsForSessions, sessionsToInventory } from "./notes";
import type { CapturedNote, WrittenNote } from "./types";
import { defaultReportPath, writeAndOpenReport } from "./write";

export interface EmitReportOptions {
  notes?: CapturedNote[];
  sessions?: AgentSession[];
  orgName?: string;
  repo?: string;
  branch?: string;
  out?: string;
  open?: boolean;
  dryRun?: boolean;
  openUrl?: (url: string) => Promise<unknown>;
  generatedAt?: Date;
  /** Backend note fetch for the history backfill; injectable for tests. */
  fetchRemote?: (cfg: Config) => Promise<WrittenNote[]>;
}

function sessionsMatchingNotes(
  notes: readonly CapturedNote[],
  sessions: readonly AgentSession[],
): AgentSession[] {
  const ids = new Set(notes.map((n) => n.transcript_id).filter((id): id is string => Boolean(id)));
  if (ids.size === 0) return [...sessions];
  const matched = sessions.filter((s) => ids.has(s.id));
  return matched.length > 0 ? matched : [...sessions];
}

function reportRepoFromNotes(notes: readonly CapturedNote[]): string | undefined {
  return notes.find((n) => n.repo)?.repo;
}

function reportBranchFromNotes(notes: readonly CapturedNote[]): string | undefined {
  return notes.find((n) => n.branch)?.branch;
}

export async function emitKnowledgeReport(options: EmitReportOptions = {}): Promise<string> {
  const cfg = loadConfig();
  const state = loadSyncState();
  const scanned = options.sessions ?? scanAgentSessions();
  let notes: CapturedNote[];
  if (options.notes) {
    notes = options.notes;
  } else {
    // Persisted local window plus the backend backfill (notes mined before
    // local capture existed, or from another machine). Fail-open: an empty
    // remote result leaves the local window untouched.
    const remote = await (options.fetchRemote ?? fetchRemoteNotes)(cfg);
    const merged = mergeRemoteNotes((state.written_notes ?? []) as WrittenNote[], remote);
    // Backfilled notes carry a run id, not a transcript: recover attribution
    // through the mined_sessions ledger where a clear winner exists.
    notes = correlateRemoteNotes(merged, state.mined_sessions ?? [], scanned);
  }
  const sessions = sessionsMatchingNotes(notes, scanned);
  const candidates = attributeRediscovery(notes, sessions);
  const inventory = sessionsToInventory(sessions);
  if (inventory.totals && state.total_learning_tokens && !options.sessions) {
    // Standalone report: use the all-time distilled baseline when present.
    inventory.totals.learning_tokens = state.total_learning_tokens;
  }
  const html = buildReportHtml({
    inventory,
    candidates,
    orgName: options.orgName ?? cfg.active_account?.target?.org_name ?? "Your team",
    repo: options.repo ?? reportRepoFromNotes(notes),
    branch: options.branch ?? reportBranchFromNotes(notes),
    dryRun: options.dryRun,
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
