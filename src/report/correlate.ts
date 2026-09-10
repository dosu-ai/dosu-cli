/**
 * Recover transcript attribution for backfilled notes: the backend stores the
 * miner's run id (as `session_id`) and the write time, and the local watermark
 * ledger records which sessions each completed run mined. Group notes by run,
 * match the run to its ledger batch by time, then rank the batch's sessions by
 * the same cycle scorer the report uses — assigning only on a clear win, so an
 * ambiguous match renders as a bare card rather than a wrong trace.
 * Validated against real production data: ~80% of historical mined notes get a
 * clear winner; the rest stay unattributed.
 */

import type { AgentSession } from "../sessions/scan";
import type { MinedSessionRecord } from "../sync/watermark";
import { sessionToDigest } from "./digest";
import { cycleMatchScore, noteWords, type SessionCycle, sessionCycles } from "./notes";
import type { WrittenNote } from "./types";

/** Batch stamps are minutes after the notes' writes (run end vs. during-run);
 * anything further apart than this is a different run. */
const BATCH_TOLERANCE_MS = 30 * 60 * 1000;
/** Attribute only when the best session clearly beats the runner-up. */
const CLEAR_WIN_RATIO = 1.5;

function noteTime(note: WrittenNote): number {
  const parsed = Date.parse(note.at);
  return Number.isNaN(parsed) ? Number.NaN : parsed;
}

/** Nearest ledger batch timestamp within tolerance, or undefined. */
function nearestBatch(batchTimes: { at: string; t: number }[], time: number): string | undefined {
  if (Number.isNaN(time)) return undefined;
  let best: { at: string; d: number } | undefined;
  for (const batch of batchTimes) {
    const d = Math.abs(batch.t - time);
    if (d <= BATCH_TOLERANCE_MS && (!best || d < best.d)) best = { at: batch.at, d };
  }
  return best?.at;
}

/**
 * Fill `transcript_id` on backfilled notes where the run→batch→session chain
 * finds a clear winner. Notes already attributed (local capture) are returned
 * unchanged; so is everything the chain cannot place confidently.
 */
export function correlateRemoteNotes(
  notes: readonly WrittenNote[],
  ledger: readonly MinedSessionRecord[],
  sessions: readonly AgentSession[],
): WrittenNote[] {
  const targets = notes.map((note, i) => ({ note, i })).filter(({ note }) => !note.transcript_id);
  if (targets.length === 0 || ledger.length === 0 || sessions.length === 0) return [...notes];

  // Ledger batches: one entry per completed run, keyed by the run's stamp.
  const batches = new Map<string, string[]>();
  for (const record of ledger) {
    const members = batches.get(record.at) ?? [];
    members.push(record.session);
    batches.set(record.at, members);
  }
  const batchTimes = [...batches.keys()]
    .map((at) => ({ at, t: Date.parse(at) }))
    .filter((b) => !Number.isNaN(b.t));

  const sessionByKey = new Map(sessions.map((s) => [`${s.harness}/${s.id}`, s]));
  // Cycle texts are built once per session, not once per note.
  const cyclesCache = new Map<string, SessionCycle[]>();
  const cyclesFor = (session: AgentSession): SessionCycle[] => {
    let cycles = cyclesCache.get(session.id);
    if (!cycles) {
      cycles = sessionCycles(sessionToDigest(session).turns);
      cyclesCache.set(session.id, cycles);
    }
    return cycles;
  };

  // Notes from one run share its batch; a note with no run id is its own group.
  const groups = new Map<string, { indexes: number[]; latest: number }>();
  for (const { note, i } of targets) {
    const key = note.run_id ?? `note:${i}`;
    const time = noteTime(note);
    const group = groups.get(key) ?? { indexes: [], latest: Number.NaN };
    group.indexes.push(i);
    if (!Number.isNaN(time) && !(group.latest >= time)) group.latest = time;
    groups.set(key, group);
  }

  const out = [...notes];
  for (const group of groups.values()) {
    const batchAt = nearestBatch(batchTimes, group.latest);
    if (!batchAt) continue;
    const members = (batches.get(batchAt) ?? [])
      .map((key) => sessionByKey.get(key))
      .filter((s): s is AgentSession => s !== undefined);
    if (members.length === 0) continue;

    for (const i of group.indexes) {
      const words = noteWords(out[i]);
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
      if (!best || best.score === 0) continue;
      if (second > 0 && best.score < second * CLEAR_WIN_RATIO) continue;
      out[i] = { ...out[i], transcript_id: best.session.id };
    }
  }
  return out;
}
