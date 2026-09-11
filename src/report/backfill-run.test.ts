import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Config } from "../config/config";
import type { AgentSession } from "../sessions/scan";

const mockQuery = vi.fn();
const mockMutate = vi.fn();
vi.mock("../client/trpc", () => ({
  createTypedClient: () => ({
    notes: {
      listMine: { query: (i: unknown) => mockQuery(i) },
      attributeTranscripts: { mutate: (i: unknown) => mockMutate(i) },
    },
  }),
}));

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

describe("runBackfill default backend seams", () => {
  const authedCfg = {
    active_account: {
      session: { access_token: "t", refresh_token: "r", expires_at: 0 },
      target: { org_id: "11111111-1111-4111-8111-111111111111" },
    },
  } as unknown as Config;

  beforeEach(() => {
    mockQuery.mockReset();
    mockMutate.mockReset();
  });

  it("fetches only unattributed notes and applies the correlated mappings over the client", async () => {
    const oauth = session("s-oauth", "why does oauth retry after 401 in tokens.py refresh path");
    mockQuery.mockResolvedValue({
      notes: [
        {
          id: "n1",
          title: "OAuth retry after 401",
          body: "tokens.py refresh path",
          transcript_id: null,
          created_at: "2026-09-09T10:00:00Z",
        },
        // already attributed — must be filtered out before correlation
        {
          id: "n2",
          title: "Done",
          body: "x",
          transcript_id: "already",
          created_at: "2026-09-09T10:00:00Z",
        },
      ],
    });
    mockMutate.mockResolvedValue({ updated: 1 });

    const result = await runBackfill({
      loadCfg: () => authedCfg,
      ledger: () => [{ at: "2026-09-09T10:05:00Z", session: "claude/s-oauth" }],
      scan: () => [oauth],
    });

    expect(mockQuery).toHaveBeenCalledWith({
      org_id: "11111111-1111-4111-8111-111111111111",
      limit: 500,
    });
    expect(result.candidates).toBe(1); // n2 filtered
    expect(mockMutate).toHaveBeenCalledWith({
      mappings: [{ note_id: "n1", transcript_id: "s-oauth" }],
    });
    expect(result.updated).toBe(1);
  });

  it("throws an actionable error when signed out", async () => {
    await expect(
      runBackfill({ loadCfg: () => ({}) as Config, ledger: () => [], scan: () => [] }),
    ).rejects.toThrow(/Not signed in/);
  });
});
