import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { AgentSession } from "../sessions/scan";
import {
  backoffUntil,
  DEFAULT_QUIET_PERIOD_MS,
  filterSessionsByProject,
  gateSessions,
  loadSyncState,
  type SyncState,
  saveSyncState,
  sessionProject,
  syncStatePath,
  UNKNOWN_PROJECT,
} from "./watermark";

let configDir: string;

beforeEach(() => {
  configDir = mkdtempSync(join(tmpdir(), "dosu-sync-test-"));
});

afterEach(() => {
  rmSync(configDir, { recursive: true, force: true });
});

const NOW = new Date("2026-08-25T12:00:00Z");

function session(overrides: Partial<AgentSession> = {}): AgentSession {
  const id = `s-${Math.random().toString(36).slice(2)}`;
  return {
    id,
    harness: "claude",
    path: `/tmp/${id}.jsonl`,
    updated: "2026-08-25T11:00:00Z",
    ...overrides,
  };
}

describe("loadSyncState / saveSyncState", () => {
  it("returns an empty state when no file exists", () => {
    const state = loadSyncState(configDir);
    expect(state.watermark).toBeNull();
    expect(state.consecutive_failures).toBe(0);
  });

  it("round-trips state through disk", () => {
    const state: SyncState = {
      schema_version: 1,
      watermark: "2026-08-25T11:00:00Z",
      last_attempt_at: "2026-08-25T11:05:00Z",
      consecutive_failures: 2,
      mined_sessions: [{ at: "2026-08-25T11:04:00Z", session: "cursor/abc", project: "dosu" }],
      total_mined: 12,
      total_notes: 5,
      total_learning_tokens: 42_000,
      last_refusal: {
        at: "2026-08-25T11:05:00Z",
        outcome: "credit_limit",
        message: "Your org has used its Dosu credits for this billing period.",
      },
    };
    saveSyncState(state, configDir);
    expect(loadSyncState(configDir)).toEqual(state);
  });

  it("drops a malformed last_refusal", () => {
    writeFileSync(
      syncStatePath(configDir),
      JSON.stringify({
        schema_version: 1,
        watermark: null,
        consecutive_failures: 0,
        last_refusal: { outcome: "credit_limit" },
      }),
    );
    expect(loadSyncState(configDir).last_refusal).toBeUndefined();
  });

  it("writes owner-only files with no temp residue", () => {
    saveSyncState({ schema_version: 1, watermark: null, consecutive_failures: 0 }, configDir);
    const content = readFileSync(syncStatePath(configDir), "utf-8");
    expect(JSON.parse(content).schema_version).toBe(1);
  });

  it("treats a corrupt file as empty state", () => {
    writeFileSync(syncStatePath(configDir), "{nope");
    expect(loadSyncState(configDir).watermark).toBeNull();
  });

  it("treats an unknown schema_version as empty state", () => {
    writeFileSync(
      syncStatePath(configDir),
      JSON.stringify({ schema_version: 99, watermark: "2026-01-01T00:00:00Z" }),
    );
    expect(loadSyncState(configDir).watermark).toBeNull();
  });

  it("normalizes malformed fields", () => {
    writeFileSync(
      syncStatePath(configDir),
      JSON.stringify({ schema_version: 1, watermark: 42, consecutive_failures: -3 }),
    );
    const state = loadSyncState(configDir);
    expect(state.watermark).toBeNull();
    expect(state.consecutive_failures).toBe(0);
    expect(state.mined_sessions).toEqual([]);
    expect(state.total_mined).toBe(0);
    // Analytics counters predating this schema addition default to zero.
    expect(state.total_notes).toBe(0);
    expect(state.total_learning_tokens).toBe(0);
  });

  it("drops malformed mined-session records and backfills the count", () => {
    writeFileSync(
      syncStatePath(configDir),
      JSON.stringify({
        schema_version: 1,
        watermark: null,
        consecutive_failures: 0,
        mined_sessions: [
          { at: "2026-08-25T11:04:00Z", session: "cursor/abc" },
          { at: "2026-08-25T11:05:00Z", session: "cursor/def", project: 42 },
          { at: 42 },
          "nope",
          null,
        ],
        total_mined: "many",
      }),
    );
    const state = loadSyncState(configDir);
    // A non-string project is dropped from the surviving record.
    expect(state.mined_sessions).toEqual([
      { at: "2026-08-25T11:04:00Z", session: "cursor/abc" },
      { at: "2026-08-25T11:05:00Z", session: "cursor/def" },
    ]);
    // A bad counter falls back to what the surviving history proves.
    expect(state.total_mined).toBe(2);
  });
});

describe("project filter", () => {
  it("round-trips through disk and drops non-string entries", () => {
    saveSyncState(
      {
        schema_version: 1,
        watermark: null,
        consecutive_failures: 0,
        project_filter: ["dosu-cli", UNKNOWN_PROJECT],
      },
      configDir,
    );
    expect(loadSyncState(configDir).project_filter).toEqual(["dosu-cli", UNKNOWN_PROJECT]);

    writeFileSync(
      syncStatePath(configDir),
      JSON.stringify({
        schema_version: 1,
        watermark: null,
        consecutive_failures: 0,
        project_filter: ["dosu", 42, null],
      }),
    );
    expect(loadSyncState(configDir).project_filter).toEqual(["dosu"]);
  });

  it("filterSessionsByProject passes everything without a filter", () => {
    const sessions = [session({ project: "a" }), session()];
    expect(filterSessionsByProject(sessions, undefined)).toEqual(sessions);
    expect(filterSessionsByProject(sessions, [])).toEqual(sessions);
  });

  it("filterSessionsByProject keeps matches, bucketing unknowns", () => {
    const inScope = session({ project: "dosu-cli" });
    const outScope = session({ project: "other" });
    const unknown = session();
    expect(sessionProject(unknown)).toBe(UNKNOWN_PROJECT);
    expect(filterSessionsByProject([inScope, outScope, unknown], ["dosu-cli"])).toEqual([inScope]);
    expect(
      filterSessionsByProject([inScope, outScope, unknown], ["dosu-cli", UNKNOWN_PROJECT]),
    ).toEqual([inScope, unknown]);
  });
});

describe("backoffUntil", () => {
  it("returns null with no failures", () => {
    expect(
      backoffUntil({ schema_version: 1, watermark: null, consecutive_failures: 0 }),
    ).toBeNull();
  });

  it("returns null when there is no attempt timestamp", () => {
    expect(
      backoffUntil({ schema_version: 1, watermark: null, consecutive_failures: 3 }),
    ).toBeNull();
  });

  it("doubles the delay per failure starting at 15 minutes", () => {
    const base = Date.parse("2026-08-25T12:00:00Z");
    const state = (failures: number): SyncState => ({
      schema_version: 1,
      watermark: null,
      last_attempt_at: "2026-08-25T12:00:00Z",
      consecutive_failures: failures,
    });
    expect(backoffUntil(state(1))?.getTime()).toBe(base + 15 * 60 * 1000);
    expect(backoffUntil(state(2))?.getTime()).toBe(base + 30 * 60 * 1000);
    expect(backoffUntil(state(3))?.getTime()).toBe(base + 60 * 60 * 1000);
  });

  it("caps the delay at 24 hours", () => {
    const base = Date.parse("2026-08-25T12:00:00Z");
    const until = backoffUntil({
      schema_version: 1,
      watermark: null,
      last_attempt_at: "2026-08-25T12:00:00Z",
      consecutive_failures: 20,
    });
    expect(until?.getTime()).toBe(base + 24 * 60 * 60 * 1000);
  });
});

describe("gateSessions", () => {
  it("splits completed vs open sessions on the quiet period", () => {
    const fresh = session({ updated: new Date(NOW.getTime() - 60 * 1000).toISOString() });
    const settled = session({ updated: new Date(NOW.getTime() - 10 * 60 * 1000).toISOString() });

    const result = gateSessions([fresh, settled], null, NOW, DEFAULT_QUIET_PERIOD_MS);

    expect(result.ready.map((s) => s.id)).toEqual([settled.id]);
    expect(result.open.map((s) => s.id)).toEqual([fresh.id]);
  });

  it("excludes sessions at or below the watermark", () => {
    const older = session({ updated: "2026-08-25T09:00:00Z" });
    const atMark = session({ updated: "2026-08-25T10:00:00Z" });
    const newer = session({ updated: "2026-08-25T10:30:00Z" });

    const result = gateSessions([older, atMark, newer], "2026-08-25T10:00:00Z", NOW);

    expect(result.ready.map((s) => s.id)).toEqual([newer.id]);
  });

  it("ignores sessions with unparseable timestamps", () => {
    const broken = session({ updated: "not-a-date" });
    expect(gateSessions([broken], null, NOW).ready).toHaveLength(0);
  });

  it("handles offset timestamps", () => {
    const offsetSession = session({ updated: "2026-08-25T04:00:00.758553246-07:00" });
    const result = gateSessions([offsetSession], null, NOW);
    expect(result.ready).toHaveLength(1);
  });
});
