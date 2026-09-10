import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { AgentSession } from "../sessions/scan";
import type { MinedSessionRecord } from "../sync/watermark";
import { correlateRemoteNotes } from "./correlate";
import type { WrittenNote } from "./types";

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "dosu-correlate-"));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

function claudeSession(id: string, userText: string, assistantText: string): AgentSession {
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

function note(title: string, content: string, extra: Partial<WrittenNote> = {}): WrittenNote {
  return { title, content, status: "written", at: "2026-09-09T10:00:00Z", ...extra };
}

const BATCH_AT = "2026-09-09T10:05:00Z";

function ledgerFor(...sessions: AgentSession[]): MinedSessionRecord[] {
  return sessions.map((s) => ({ at: BATCH_AT, session: `claude/${s.id}` }));
}

describe("correlateRemoteNotes", () => {
  it("attributes a run-grouped note to the clear-winning session in its batch", () => {
    const oauth = claudeSession("s-oauth", "why does oauth retry after 401?", "tokens.py refresh");
    const zebra = claudeSession("s-zebra", "tell me about zebra stripes", "they are stripey");
    const [result] = correlateRemoteNotes(
      [note("OAuth retry after 401", "tokens.py owns the refresh.", { run_id: "run-1" })],
      ledgerFor(oauth, zebra),
      [oauth, zebra],
    );
    expect(result.transcript_id).toBe("s-oauth");
  });

  it("leaves an ambiguous note unattributed instead of guessing", () => {
    // Both sessions discuss oauth retry with near-identical vocabulary.
    const a = claudeSession("s-a", "oauth retry after 401 in tokens.py", "refresh flow");
    const b = claudeSession("s-b", "oauth retry after 401 in tokens.py", "refresh path");
    const [result] = correlateRemoteNotes(
      [note("OAuth retry after 401", "tokens.py refresh.", { run_id: "run-1" })],
      ledgerFor(a, b),
      [a, b],
    );
    expect(result.transcript_id).toBeUndefined();
  });

  it("never touches notes that already carry local transcript attribution", () => {
    const s = claudeSession("s-oauth", "why does oauth retry?", "because 401");
    const [kept] = correlateRemoteNotes(
      [note("OAuth retry", "Retry after 401.", { transcript_id: "gate-captured" })],
      ledgerFor(s),
      [s],
    );
    expect(kept.transcript_id).toBe("gate-captured");
  });

  it("skips notes whose write time is outside every batch's tolerance window", () => {
    const s = claudeSession("s-oauth", "why does oauth retry after 401?", "tokens.py");
    const [result] = correlateRemoteNotes(
      [
        note("OAuth retry after 401", "tokens.py.", {
          run_id: "run-1",
          at: "2026-09-09T20:00:00Z",
        }),
      ],
      ledgerFor(s),
      [s],
    );
    expect(result.transcript_id).toBeUndefined();
  });

  it("skips batches whose sessions are no longer on disk and unscoreable notes", () => {
    const s = claudeSession("s-oauth", "why does oauth retry after 401?", "tokens.py");
    const ledger: MinedSessionRecord[] = [{ at: BATCH_AT, session: "claude/deleted-long-ago" }];
    const [gone] = correlateRemoteNotes([note("OAuth retry", "x", { run_id: "r" })], ledger, [s]);
    expect(gone.transcript_id).toBeUndefined();

    const [noOverlap] = correlateRemoteNotes(
      [note("qqqq wwww", "eeee rrrr", { run_id: "r" })],
      ledgerFor(s),
      [s],
    );
    expect(noOverlap.transcript_id).toBeUndefined();
  });

  it("correlates a note without a run id through its own timestamp", () => {
    const s = claudeSession("s-oauth", "why does oauth retry after 401?", "tokens.py refresh");
    const [result] = correlateRemoteNotes(
      [note("OAuth retry after 401", "tokens.py owns the refresh.")],
      ledgerFor(s),
      [s],
    );
    expect(result.transcript_id).toBe("s-oauth");
  });

  it("returns notes unchanged with an empty ledger, empty scan, or nothing to do", () => {
    const s = claudeSession("s-oauth", "why?", "because");
    const unattributed = [note("A", "B", { run_id: "r" })];
    expect(correlateRemoteNotes(unattributed, [], [s])).toEqual(unattributed);
    expect(correlateRemoteNotes(unattributed, ledgerFor(s), [])).toEqual(unattributed);
    const attributed = [note("A", "B", { transcript_id: "t" })];
    expect(correlateRemoteNotes(attributed, ledgerFor(s), [s])).toEqual(attributed);
  });

  it("ignores unparsable timestamps in notes and the ledger", () => {
    const s = claudeSession("s-oauth", "why does oauth retry after 401?", "tokens.py");
    const ledger: MinedSessionRecord[] = [
      { at: "not-a-date", session: `claude/${s.id}` },
      ...ledgerFor(s),
    ];
    const [ok] = correlateRemoteNotes(
      [note("OAuth retry after 401", "tokens.py.", { run_id: "r" })],
      ledger,
      [s],
    );
    expect(ok.transcript_id).toBe("s-oauth");
    const [bad] = correlateRemoteNotes(
      [note("OAuth retry after 401", "tokens.py.", { run_id: "r2", at: "garbage" })],
      ledgerFor(s),
      [s],
    );
    expect(bad.transcript_id).toBeUndefined();
  });

  it("shares one batch lookup across all notes of a run", () => {
    const oauth = claudeSession("s-oauth", "why does oauth retry after 401?", "tokens.py refresh");
    const cache = claudeSession(
      "s-cache",
      "how is the lru cache evicted?",
      "see cache.ts eviction",
    );
    const results = correlateRemoteNotes(
      [
        note("OAuth retry after 401", "tokens.py refresh.", { run_id: "run-1" }),
        note("LRU cache eviction", "cache.ts eviction order.", {
          run_id: "run-1",
          at: "2026-09-09T09:58:00Z",
        }),
      ],
      ledgerFor(oauth, cache),
      [oauth, cache],
    );
    expect(results.map((r) => r.transcript_id)).toEqual(["s-oauth", "s-cache"]);
  });
});
