/**
 * Assemble inventory + candidates from a mining run (or persisted notes)
 * and emit the skill-identical HTML report.
 */

import { loadConfig } from "../config/config";
import type { AgentSession } from "../sessions/scan";
import { scanAgentSessions } from "../sessions/scan";
import { loadSyncState } from "../sync/watermark";
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
  const notes: CapturedNote[] = options.notes ?? ((state.written_notes ?? []) as WrittenNote[]);
  const scanned = options.sessions ?? scanAgentSessions();
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
