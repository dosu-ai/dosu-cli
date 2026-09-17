import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { AgentSession } from "../sessions/scan";
import { correlateBackfill, type LedgerEntry } from "./backfill";

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "dosu-backfill-"));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

function session(id: string, userText: string, assistantText: string): AgentSession {
  const path = join(dir, `${id}.jsonl`);
  writeFileSync(
    path,
    [
      JSON.stringify({ type: "user", message: { content: userText } }),
      JSON.stringify({
        type: "assistant",
        message: { content: [{ type: "text", text: assistantText }] },
      }),
    ].join("\n"),
  );
  return { id, harness: "claude", path, updated: "2026-09-09T00:00:00.000Z" };
}

const BATCH_AT = "2026-09-09T10:05:00Z";
const NOTE_AT = "2026-09-09T10:00:00Z";
const ledger = (...s: AgentSession[]): LedgerEntry[] =>
  s.map((x) => ({ at: BATCH_AT, session: `claude/${x.id}` }));

describe("correlateBackfill", () => {
  it("attributes a note to the clear-winning session in its time batch", () => {
    const oauth = session("s-oauth", "why does oauth retry after 401?", "tokens.py refresh");
    const zebra = session("s-zebra", "tell me about zebra stripes", "stripey");
    const r = correlateBackfill({
      notes: [
        {
          id: "n1",
          title: "OAuth retry after 401",
          content: "tokens.py owns refresh.",
          at: NOTE_AT,
        },
      ],
      ledger: ledger(oauth, zebra),
      sessions: [oauth, zebra],
    });
    expect(r.mappings).toEqual([{ note_id: "n1", transcript_id: "s-oauth" }]);
    expect(r.ambiguous).toBe(0);
  });

  it("leaves an ambiguous note unattributed (two near-identical sessions)", () => {
    const a = session("s-a", "oauth retry after 401 in tokens.py", "refresh flow");
    const b = session("s-b", "oauth retry after 401 in tokens.py", "refresh path");
    const r = correlateBackfill({
      notes: [
        { id: "n1", title: "OAuth retry after 401", content: "tokens.py refresh.", at: NOTE_AT },
      ],
      ledger: ledger(a, b),
      sessions: [a, b],
    });
    expect(r.mappings).toEqual([]);
    expect(r.ambiguous).toBe(1);
  });

  it("enforces an absolute floor: a single trivial word never wins", () => {
    const s = session("s-x", "the report", "the report");
    const r = correlateBackfill({
      notes: [{ id: "n1", title: "report", content: "", at: NOTE_AT }],
      ledger: ledger(s),
      sessions: [s],
    });
    // "report" scores 2 (title x2), below MIN_SCORE=3.
    expect(r.mappings).toEqual([]);
    expect(r.ambiguous).toBe(1);
  });

  it("counts a note whose write time matches no batch as noBatch", () => {
    const s = session("s-oauth", "why does oauth retry after 401?", "tokens.py");
    const r = correlateBackfill({
      notes: [
        {
          id: "n1",
          title: "OAuth retry after 401",
          content: "tokens.py",
          at: "2026-09-09T20:00:00Z",
        },
      ],
      ledger: ledger(s),
      sessions: [s],
    });
    expect(r.mappings).toEqual([]);
    expect(r.noBatch).toBe(1);
  });

  it("counts an unparsable note timestamp as noBatch", () => {
    const s = session("s-oauth", "why does oauth retry after 401?", "tokens.py");
    const r = correlateBackfill({
      notes: [{ id: "n1", title: "OAuth retry after 401", content: "tokens.py", at: "not-a-date" }],
      ledger: ledger(s),
      sessions: [s],
    });
    expect(r.noBatch).toBe(1);
  });

  it("skips a batch whose sessions are no longer on disk", () => {
    const s = session("s-oauth", "why does oauth retry after 401?", "tokens.py");
    const r = correlateBackfill({
      notes: [{ id: "n1", title: "OAuth retry after 401", content: "tokens.py", at: NOTE_AT }],
      ledger: [{ at: BATCH_AT, session: "claude/deleted" }],
      sessions: [s],
    });
    expect(r.mappings).toEqual([]);
    expect(r.noBatch).toBe(1);
  });
});
