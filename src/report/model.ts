/** The report model: the shipped sessions' lineages, plus what they did to memory across the
 * whole period — each memory once, with every effect any session had on it. */

import type { Report, ReportMemory, ReportSession, ReportTotals, SourceEffect } from "./types";

export interface BuildReportInput {
  generatedAt: string;
  days: number;
  orgName: string;
  appUrl: string;
  sessions: ReportSession[];
}

/** Effects that changed what the org knows, as opposed to confirming it. */
const CHANGES: ReadonlySet<SourceEffect> = new Set(["created", "updated", "contradicted"]);

/** When the session itself happened: a backfill ships a month of sessions in one minute, so
 * the shipment only stands in when the trace is not readable yet. */
export function sessionTime(session: ReportSession): string {
  const trace = session.trace?.trace;
  return trace?.ended_at ?? trace?.started_at ?? session.shippedAt;
}

function newestFirst(a: ReportSession, b: ReportSession): number {
  return Date.parse(sessionTime(b)) - Date.parse(sessionTime(a));
}

function rank(memory: ReportMemory): [number, number, number] {
  return [
    memory.sessionIds.length,
    memory.effects.some((e) => CHANGES.has(e)) ? 1 : 0,
    Date.parse(memory.item.updated_at),
  ];
}

function compareMemories(a: ReportMemory, b: ReportMemory): number {
  const ra = rank(a);
  const rb = rank(b);
  for (let i = 0; i < ra.length; i++) {
    if (ra[i] !== rb[i]) return rb[i] - ra[i];
  }
  return 0;
}

export function buildReport(input: BuildReportInput): Report {
  const sessions = [...input.sessions].sort(newestFirst);

  // Oldest first, so a memory's effects and sessions read in the order things happened.
  const byId = new Map<string, ReportMemory>();
  for (const session of [...sessions].reverse()) {
    for (const touched of session.trace?.memories ?? []) {
      const seen = byId.get(touched.item.id);
      if (!seen) {
        byId.set(touched.item.id, {
          item: touched.item,
          effects: [...touched.effects],
          sessionIds: [session.sessionId],
        });
        continue;
      }
      if (Date.parse(touched.item.updated_at) > Date.parse(seen.item.updated_at)) {
        seen.item = touched.item;
      }
      for (const effect of touched.effects) {
        if (!seen.effects.includes(effect)) seen.effects.push(effect);
      }
      if (!seen.sessionIds.includes(session.sessionId)) seen.sessionIds.push(session.sessionId);
    }
  }
  const memories = [...byId.values()].sort(compareMemories);

  const totals: ReportTotals = {
    sessions: sessions.length,
    processed: sessions.filter((s) => s.state === "complete").length,
    tasks: 0,
    episodes: 0,
    memories: memories.length,
    created: 0,
    updated: 0,
    confirmed: 0,
    contradicted: 0,
  };
  for (const session of sessions) {
    totals.tasks += session.trace?.tasks.length ?? 0;
    totals.episodes += session.trace?.episodes.length ?? 0;
  }
  for (const memory of memories) {
    for (const effect of memory.effects) totals[effect] += 1;
  }

  return { ...input, sessions, memories, totals };
}
