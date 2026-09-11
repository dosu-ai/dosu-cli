/**
 * Orchestrates the local transcript backfill: fetch the caller's unattributed
 * notes, correlate them against the local mining ledger and session logs, and
 * post the recovered {note_id -> transcript_id} pairs back. Injectable seams
 * keep it unit-testable without a backend or a real home directory.
 */

import { type Config, loadConfig } from "../config/config";
import type { AgentSession } from "../sessions/scan";
import { scanAgentSessions } from "../sessions/scan";
import { loadSyncState } from "../sync/watermark";
import { type BackfillResult, correlateBackfill, type TranscriptMapping } from "./backfill";

/** ≤500 per attributeTranscripts call (contract cap). */
const MUTATION_CHUNK = 500;

export interface BackfillRunResult extends BackfillResult {
  /** Notes fetched that still lacked a transcript_id. */
  candidates: number;
  /** Rows the backend actually updated (own, still-null notes). */
  updated: number;
}

export interface BackfillDeps {
  loadCfg?: () => Config;
  scan?: () => AgentSession[];
  fetchUnattributed?: (
    cfg: Config,
  ) => Promise<{ id: string; title: string; content: string; at?: string }[]>;
  ledger?: () => { at: string; session: string }[];
  apply?: (cfg: Config, mappings: TranscriptMapping[]) => Promise<number>;
}

async function defaultFetchUnattributed(cfg: Config) {
  const orgId = cfg.active_account?.target?.org_id;
  if (!orgId || !cfg.active_account?.session.access_token) {
    throw new Error("Not signed in. Run `dosu setup` to connect an account first.");
  }
  const { createTypedClient } = await import("../client/trpc");
  const client = createTypedClient(cfg);
  const { notes } = await client.notes.listMine.query({ org_id: orgId, limit: 500 });
  return notes
    .filter((n) => !n.transcript_id)
    .map((n) => ({ id: n.id, title: n.title, content: n.body, at: n.created_at }));
}

async function defaultApply(cfg: Config, mappings: TranscriptMapping[]): Promise<number> {
  const { createTypedClient } = await import("../client/trpc");
  const client = createTypedClient(cfg);
  let updated = 0;
  for (let i = 0; i < mappings.length; i += MUTATION_CHUNK) {
    const chunk = mappings.slice(i, i + MUTATION_CHUNK);
    const res = await client.notes.attributeTranscripts.mutate({ mappings: chunk });
    updated += res.updated;
  }
  return updated;
}

export async function runBackfill(deps: BackfillDeps = {}): Promise<BackfillRunResult> {
  const cfg = (deps.loadCfg ?? loadConfig)();
  const notes = await (deps.fetchUnattributed ?? defaultFetchUnattributed)(cfg);
  if (notes.length === 0) {
    return { candidates: 0, mappings: [], ambiguous: 0, noBatch: 0, updated: 0 };
  }
  const ledger = (deps.ledger ?? (() => loadSyncState().mined_sessions ?? []))();
  const sessions = (deps.scan ?? scanAgentSessions)();
  const { mappings, ambiguous, noBatch } = correlateBackfill({ notes, ledger, sessions });
  const updated = mappings.length > 0 ? await (deps.apply ?? defaultApply)(cfg, mappings) : 0;
  return { candidates: notes.length, mappings, ambiguous, noBatch, updated };
}
