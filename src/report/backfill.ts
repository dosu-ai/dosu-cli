/**
 * One-shot local backfill of per-note transcript_id for notes written before
 * the miner injected it. Everything happens on the user's machine: their notes
 * come from the backend (content only), and the conversation each was learned
 * from is recovered by matching the note against the local session logs its
 * mining run read — the mining ledger and the logs never leave the machine.
 * Only the resulting {note_id -> transcript_id} pairs are sent back.
 *
 * Run identity is gone from the backend (session_id was dropped), so notes are
 * grouped to a mining batch by write time rather than by run id: each note is
 * matched to the nearest ledger batch, then content-scored against that batch's
 * sessions, and attributed only on a clear win — an ambiguous note stays
 * unattributed rather than getting a wrong trace.
 */

import type { AgentSession } from "../sessions/scan";
import { sessionToDigest } from "./digest";
import { cycleMatchScore, noteWords, type SessionCycle, sessionCycles } from "./notes";

/** Ledger batch stamps are minutes after the run's writes; further apart is a different run. */
const BATCH_TOLERANCE_MS = 30 * 60 * 1000;
/** Attribute only when the best session clearly beats the runner-up. */
const CLEAR_WIN_RATIO = 1.5;
/** And clears an absolute floor, so a single shared word never wins an all-else-zero batch. */
const MIN_SCORE = 3;

export interface LedgerEntry {
  /** ISO stamp the run recorded this session at (shared by a batch). */
  at: string;
  /** "harness/id". */
  session: string;
}

export interface TranscriptMapping {
  note_id: string;
  transcript_id: string;
}

export interface BackfillInput {
  /** Notes to attribute: id + content, transcript_id currently unset. */
  notes: ReadonlyArray<{ id: string; title: string; content: string; at?: string }>;
  ledger: readonly LedgerEntry[];
  sessions: readonly AgentSession[];
}

export interface BackfillResult {
  mappings: TranscriptMapping[];
  /** Notes that matched a batch but no session clearly enough. */
  ambiguous: number;
  /** Notes whose write time matched no ledger batch. */
  noBatch: number;
}

function noteTime(at: string | undefined): number {
  const parsed = Date.parse(at ?? "");
  return Number.isNaN(parsed) ? Number.NaN : parsed;
}

/** Recover transcript ids for notes, matching each against its nearest mining
 * batch's local sessions. Pure: no I/O, no network — the caller supplies the
 * ledger and scanned sessions and sends the mappings. */
export function correlateBackfill(input: BackfillInput): BackfillResult {
  const batches = new Map<string, string[]>();
  for (const e of input.ledger) {
    const members = batches.get(e.at) ?? [];
    members.push(e.session);
    batches.set(e.at, members);
  }
  const batchTimes = [...batches.keys()]
    .map((at) => ({ at, t: Date.parse(at) }))
    .filter((b) => !Number.isNaN(b.t));
  const sessionByKey = new Map(input.sessions.map((s) => [`${s.harness}/${s.id}`, s]));

  const cyclesCache = new Map<string, SessionCycle[]>();
  const cyclesFor = (session: AgentSession): SessionCycle[] => {
    let cycles = cyclesCache.get(session.id);
    if (!cycles) {
      cycles = sessionCycles(sessionToDigest(session).turns);
      cyclesCache.set(session.id, cycles);
    }
    return cycles;
  };

  const mappings: TranscriptMapping[] = [];
  let ambiguous = 0;
  let noBatch = 0;

  for (const note of input.notes) {
    const time = noteTime(note.at);
    if (Number.isNaN(time)) {
      noBatch += 1;
      continue;
    }
    let batchAt: string | undefined;
    let bestD = Number.POSITIVE_INFINITY;
    for (const b of batchTimes) {
      const d = Math.abs(b.t - time);
      if (d <= BATCH_TOLERANCE_MS && d < bestD) {
        bestD = d;
        batchAt = b.at;
      }
    }
    if (!batchAt) {
      noBatch += 1;
      continue;
    }
    const members = (batches.get(batchAt) ?? [])
      .map((k) => sessionByKey.get(k))
      .filter((s): s is AgentSession => s !== undefined);
    if (members.length === 0) {
      noBatch += 1;
      continue;
    }
    const words = noteWords(note);
    let best: { session: AgentSession; score: number } | undefined;
    let second = 0;
    for (const session of members) {
      let score = 0;
      for (const cycle of cyclesFor(session)) {
        const s = cycleMatchScore(words, cycle.text);
        if (s > score) score = s;
      }
      if (!best || score > best.score) {
        second = best?.score ?? 0;
        best = { session, score };
      } else if (score > second) {
        second = score;
      }
    }
    if (!best || best.score < MIN_SCORE || (second > 0 && best.score < second * CLEAR_WIN_RATIO)) {
      ambiguous += 1;
      continue;
    }
    mappings.push({ note_id: note.id, transcript_id: best.session.id });
  }
  return { mappings, ambiguous, noBatch };
}
