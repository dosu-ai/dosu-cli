import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Config } from "../config/config";
import type { AgentSession } from "../sessions/scan";
import { runBackfill } from "./backfill-run";

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "dosu-backfill-run-"));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

function session(id: string, userText: string): AgentSession {
  const path = join(dir, `${id}.jsonl`);
  writeFileSync(path, JSON.stringify({ type: "user", message: { content: userText } }));
  return { id, harness: "claude", path, updated: "2026-09-09T00:00:00.000Z" };
}

const cfg = {} as Config;

describe("runBackfill", () => {
  it("correlates unattributed notes and applies only the clear-win mappings", async () => {
    const oauth = session("s-oauth", "why does oauth retry after 401 in tokens.py refresh path");
    const applied: { note_id: string; transcript_id: string }[] = [];
    const result = await runBackfill({
      loadCfg: () => cfg,
      fetchUnattributed: async () => [
        {
          id: "n1",
          title: "OAuth retry after 401",
          content: "tokens.py refresh path",
          at: "2026-09-09T10:00:00Z",
        },
      ],
      ledger: () => [{ at: "2026-09-09T10:05:00Z", session: "claude/s-oauth" }],
      scan: () => [oauth],
      apply: async (_c, m) => {
        applied.push(...m);
        return m.length;
      },
    });
    expect(result.mappings).toEqual([{ note_id: "n1", transcript_id: "s-oauth" }]);
    expect(result.updated).toBe(1);
    expect(applied).toEqual([{ note_id: "n1", transcript_id: "s-oauth" }]);
  });

  it("short-circuits with no candidates and never calls apply", async () => {
    const apply = vi.fn();
    const result = await runBackfill({
      loadCfg: () => cfg,
      fetchUnattributed: async () => [],
      ledger: () => [],
      scan: () => [],
      apply,
    });
    expect(result).toMatchObject({ candidates: 0, updated: 0, mappings: [] });
    expect(apply).not.toHaveBeenCalled();
  });

  it("does not call apply when nothing correlates", async () => {
    const apply = vi.fn();
    const result = await runBackfill({
      loadCfg: () => cfg,
      fetchUnattributed: async () => [
        { id: "n1", title: "Unrelated", content: "no overlap", at: "2026-01-01T00:00:00Z" },
      ],
      ledger: () => [{ at: "2026-09-09T10:05:00Z", session: "claude/s-oauth" }],
      scan: () => [session("s-oauth", "why does oauth retry")],
      apply,
    });
    expect(result.updated).toBe(0);
    expect(result.noBatch).toBe(1);
    expect(apply).not.toHaveBeenCalled();
  });
});
