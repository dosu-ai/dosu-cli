import { describe, expect, it, vi } from "vitest";
import type { MinerRunResult } from "../miner/runner";
import type { AgentSession } from "../sessions/scan";
import type { SyncLock } from "./lock";
import { MINE_BATCH_LIMIT, runKnowledgeSync, type SyncDeps } from "./sync";
import type { SyncState } from "./watermark";

const mockLoggerDebug = vi.hoisted(() => vi.fn());
vi.mock("../debug/logger", () => ({
  logger: { debug: mockLoggerDebug, info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

const mockScanSessions = vi.hoisted(() => vi.fn());
vi.mock("../sessions/scan", () => ({
  scanAgentSessions: (...args: unknown[]) => mockScanSessions(...args),
}));

const NOW = new Date("2026-08-25T12:00:00Z");

function session(updatedOffsetMinutes: number): AgentSession {
  return {
    id: `s-${updatedOffsetMinutes}`,
    harness: "claude",
    path: `/tmp/s-${updatedOffsetMinutes}.jsonl`,
    updated: new Date(NOW.getTime() - updatedOffsetMinutes * 60 * 1000).toISOString(),
  };
}

function makeDeps(overrides: Partial<SyncDeps> = {}): {
  deps: SyncDeps;
  saved: SyncState[];
} {
  const saved: SyncState[] = [];
  const deps: SyncDeps = {
    listSessions: vi.fn().mockResolvedValue([]),
    loadState: () => ({ schema_version: 1, watermark: null, consecutive_failures: 0 }),
    saveState: (state) => saved.push(state),
    now: () => NOW,
    ...overrides,
  };
  return { deps, saved };
}

describe("runKnowledgeSync", () => {
  it("reports a backlog of completed sessions past the gate", async () => {
    const { deps } = makeDeps({
      listSessions: vi.fn().mockResolvedValue([session(60), session(30), session(1)]),
    });

    const outcome = await runKnowledgeSync({ deps });

    expect(outcome.status).toBe("backlog");
    expect(outcome.readySessions).toBe(2);
    expect(outcome.inFlightSessions).toBe(1);
    // The backlog itself is exposed so callers can show what was selected.
    expect(outcome.sessions.map((s) => s.id)).toEqual(["s-60", "s-30"]);
  });

  it("logs the gate result with a capped session preview", async () => {
    mockLoggerDebug.mockClear();
    const sessions = Array.from({ length: 12 }, (_, i) => session(30 + i));
    const { deps } = makeDeps({ listSessions: vi.fn().mockResolvedValue(sessions) });

    await runKnowledgeSync({ deps });

    const logged = mockLoggerDebug.mock.calls.map((c) => c.join(" ")).join("\n");
    expect(logged).toContain("gate: 12 ready, 0 in flight (watermark none)");
    expect(logged).toContain("claude/s-30");
    expect(logged).toContain("(+2 more)");
  });

  it("gates out sessions outside the project filter", async () => {
    const inScope = { ...session(60), project: "dosu-cli" };
    const outScope = { ...session(30), project: "other" };
    const unknown = session(40); // no project info → "(unknown)"
    const { deps } = makeDeps({
      loadState: () => ({
        schema_version: 1,
        watermark: null,
        consecutive_failures: 0,
        project_filter: ["dosu-cli"],
      }),
      listSessions: vi.fn().mockResolvedValue([inScope, outScope, unknown]),
    });

    const outcome = await runKnowledgeSync({ deps });

    expect(outcome.status).toBe("backlog");
    expect(outcome.sessions.map((s) => s.id)).toEqual([inScope.id]);
  });

  it("reports nothing-new when the gate is empty", async () => {
    const { deps } = makeDeps();
    const outcome = await runKnowledgeSync({ deps });
    expect(outcome.status).toBe("nothing-new");
  });

  it("accepts a synchronous session lister (the default scanner)", async () => {
    const { deps } = makeDeps({
      listSessions: () => [session(60)],
    });

    const outcome = await runKnowledgeSync({ deps });

    expect(outcome.status).toBe("backlog");
    expect(outcome.readySessions).toBe(1);
  });

  it("never advances the watermark on gate-and-report runs (no miner)", async () => {
    const { deps, saved } = makeDeps({
      loadState: () => ({
        schema_version: 1,
        watermark: "2026-08-25T00:00:00Z",
        consecutive_failures: 0,
      }),
      listSessions: vi.fn().mockResolvedValue([session(30)]),
    });

    await runKnowledgeSync({ deps });

    expect(saved).toHaveLength(1);
    expect(saved[0].watermark).toBe("2026-08-25T00:00:00Z");
  });

  it("resets the failure count on success", async () => {
    const { deps, saved } = makeDeps({
      loadState: () => ({
        schema_version: 1,
        watermark: null,
        last_attempt_at: "2026-08-25T11:00:00Z",
        consecutive_failures: 4,
      }),
    });

    await runKnowledgeSync({ deps });

    expect(saved[0].consecutive_failures).toBe(0);
  });

  it("returns an error outcome and increments failures when the scan fails", async () => {
    const { deps, saved } = makeDeps({
      listSessions: vi.fn().mockRejectedValue(new Error("scan exploded")),
      loadState: () => ({
        schema_version: 1,
        watermark: null,
        consecutive_failures: 1,
      }),
    });

    const outcome = await runKnowledgeSync({ deps });

    expect(outcome.status).toBe("error");
    expect(outcome.error).toContain("scan exploded");
    expect(outcome.sessions).toEqual([]);
    expect(saved[0].consecutive_failures).toBe(2);
  });

  it("quiet runs skip while backoff is in force", async () => {
    const { deps } = makeDeps({
      loadState: () => ({
        schema_version: 1,
        watermark: null,
        last_attempt_at: new Date(NOW.getTime() - 60 * 1000).toISOString(),
        consecutive_failures: 1,
      }),
    });

    const outcome = await runKnowledgeSync({ quiet: true, deps });

    expect(outcome.status).toBe("skipped-backoff");
    expect(deps.listSessions).not.toHaveBeenCalled();
  });

  it("quiet runs proceed once backoff has expired", async () => {
    const { deps } = makeDeps({
      loadState: () => ({
        schema_version: 1,
        watermark: null,
        last_attempt_at: new Date(NOW.getTime() - 16 * 60 * 1000).toISOString(),
        consecutive_failures: 1,
      }),
    });

    const outcome = await runKnowledgeSync({ quiet: true, deps });

    expect(outcome.status).toBe("nothing-new");
  });

  it("manual runs ignore backoff", async () => {
    const { deps } = makeDeps({
      loadState: () => ({
        schema_version: 1,
        watermark: null,
        last_attempt_at: new Date(NOW.getTime() - 60 * 1000).toISOString(),
        consecutive_failures: 5,
      }),
    });

    const outcome = await runKnowledgeSync({ deps });

    expect(outcome.status).toBe("nothing-new");
  });

  it("survives a failing saveState on the error path", async () => {
    const { deps } = makeDeps({
      listSessions: vi.fn().mockRejectedValue(new Error("boom")),
      saveState: () => {
        throw new Error("disk full");
      },
    });

    const outcome = await runKnowledgeSync({ deps });

    expect(outcome.status).toBe("error");
  });
});

describe("runKnowledgeSync default scan scope", () => {
  it("normal runs scan a rolling 30-day window", async () => {
    mockScanSessions.mockReset().mockReturnValue([]);
    const { deps } = makeDeps({ listSessions: undefined });

    await runKnowledgeSync({ deps });

    const arg = mockScanSessions.mock.calls[0][0] as { since: Date; limit: number };
    expect(arg.limit).toBe(200);
    expect(arg.since.toISOString()).toBe(
      new Date(NOW.getTime() - 30 * 24 * 60 * 60 * 1000).toISOString(),
    );
  });

  it("bootstrap runs scan the entire history — no age cutoff, no count cap", async () => {
    mockScanSessions.mockReset().mockReturnValue([]);
    const { deps } = makeDeps({ listSessions: undefined });

    await runKnowledgeSync({ bootstrap: true, deps });

    expect(mockScanSessions).toHaveBeenCalledWith({});
  });

  it("an injected session lister overrides the bootstrap scope", async () => {
    mockScanSessions.mockReset();
    const { deps } = makeDeps({ listSessions: vi.fn().mockResolvedValue([session(60)]) });

    const outcome = await runKnowledgeSync({ bootstrap: true, deps });

    expect(outcome.status).toBe("backlog");
    expect(mockScanSessions).not.toHaveBeenCalled();
  });
});

function minerResult(overrides: Partial<MinerRunResult> = {}): MinerRunResult {
  return { outcome: "completed", notesWritten: 2, turns: 10, ...overrides };
}

function openLock(): SyncLock {
  return { acquire: () => true, release: vi.fn() };
}

/** Mining deps with the worthiness filter defaulted open (tests use fake paths). */
function makeMiningDeps(overrides: Partial<SyncDeps> = {}) {
  return makeDeps({ worthMining: () => true, ...overrides });
}

describe("runKnowledgeSync mining", () => {
  it("mines the oldest batch and advances the watermark to its newest session", async () => {
    const mine = vi.fn().mockResolvedValue(minerResult());
    // Two more ready sessions than one batch holds, newest-first (scanner order).
    const sessions = Array.from({ length: MINE_BATCH_LIMIT + 2 }, (_, i) => session(30 + i * 10));
    const { deps, saved } = makeMiningDeps({
      listSessions: vi.fn().mockResolvedValue(sessions),
      mine,
      lock: openLock(),
    });

    const outcome = await runKnowledgeSync({ deps });

    expect(outcome.status).toBe("mined");
    expect(outcome.minedSessions).toBe(MINE_BATCH_LIMIT);
    expect(outcome.miner?.notesWritten).toBe(2);
    // The oldest MINE_BATCH_LIMIT sessions, in chronological order; the two
    // newest (offsets 30 and 40) stay in the backlog for the next round.
    const batch = mine.mock.calls[0][0] as AgentSession[];
    const expectedIds = Array.from(
      { length: MINE_BATCH_LIMIT },
      (_, i) => `s-${30 + (MINE_BATCH_LIMIT + 1 - i) * 10}`,
    );
    expect(batch.map((s) => s.id)).toEqual(expectedIds);
    // Watermark = newest updated in the batch (s-50), not the newest ready (s-30).
    expect(saved[0].watermark).toBe(session(50).updated);
    expect(saved[0].consecutive_failures).toBe(0);
  });

  it("releases the lock after mining", async () => {
    const lock = openLock();
    const { deps } = makeMiningDeps({
      listSessions: vi.fn().mockResolvedValue([session(30)]),
      mine: vi.fn().mockResolvedValue(minerResult()),
      lock,
    });

    await runKnowledgeSync({ deps });

    expect(lock.release).toHaveBeenCalled();
  });

  it("skips without touching state when another run holds the lock", async () => {
    const mine = vi.fn();
    const { deps, saved } = makeMiningDeps({
      listSessions: vi.fn().mockResolvedValue([session(30)]),
      mine,
      lock: { acquire: () => false, release: vi.fn() },
    });

    const outcome = await runKnowledgeSync({ deps });

    expect(outcome.status).toBe("skipped-lock");
    expect(mine).not.toHaveBeenCalled();
    expect(saved).toHaveLength(0);
  });

  it.each([
    "consent_off",
    "credit_limit",
    "quota_exceeded",
  ] as const)("%s is a clean skip: no watermark advance, no failure count", async (outcome) => {
    const { deps, saved } = makeMiningDeps({
      listSessions: vi.fn().mockResolvedValue([session(30)]),
      mine: vi.fn().mockResolvedValue(minerResult({ outcome, message: "nope" })),
      lock: openLock(),
    });

    const result = await runKnowledgeSync({ deps });

    expect(result.status).toBe("skipped-gateway");
    expect(result.miner?.message).toBe("nope");
    expect(saved[0].watermark).toBeNull();
    expect(saved[0].consecutive_failures).toBe(0);
    // The reason is persisted so status surfaces can explain the pause.
    expect(saved[0].last_refusal).toMatchObject({ outcome, message: "nope" });
  });

  it("clears a persisted refusal on the next successful run", async () => {
    const { deps, saved } = makeMiningDeps({
      listSessions: vi.fn().mockResolvedValue([session(30)]),
      mine: vi.fn().mockResolvedValue(minerResult({ outcome: "completed", notesWritten: 1 })),
      lock: openLock(),
      loadState: () => ({
        schema_version: 1,
        watermark: null,
        consecutive_failures: 0,
        last_refusal: { at: "2026-08-25T10:00:00Z", outcome: "credit_limit", message: "nope" },
      }),
    });

    const result = await runKnowledgeSync({ deps });

    expect(result.status).toBe("mined");
    expect(saved[0].last_refusal).toBeUndefined();
  });

  it.each([
    "error",
    "settings_conflict",
  ] as const)("%s counts as a failure and keeps the watermark", async (outcome) => {
    const { deps, saved } = makeMiningDeps({
      listSessions: vi.fn().mockResolvedValue([session(30)]),
      loadState: () => ({ schema_version: 1, watermark: null, consecutive_failures: 1 }),
      mine: vi.fn().mockResolvedValue(minerResult({ outcome, message: "bad run" })),
      lock: openLock(),
    });

    const result = await runKnowledgeSync({ deps });

    expect(result.status).toBe("mine-failed");
    expect(result.error).toBe("bad run");
    expect(saved[0].watermark).toBeNull();
    expect(saved[0].consecutive_failures).toBe(2);
  });

  it("does not mine when the gate is empty", async () => {
    const mine = vi.fn();
    const { deps } = makeMiningDeps({ mine, lock: openLock() });

    const outcome = await runKnowledgeSync({ deps });

    expect(outcome.status).toBe("nothing-new");
    expect(mine).not.toHaveBeenCalled();
  });

  it("filters trivial sessions out of the batch but rolls the watermark over them", async () => {
    const mine = vi.fn().mockResolvedValue(minerResult());
    // Newest-first: s-30 (worthy), s-40 (trivial), s-50 (worthy).
    const sessions = [session(30), session(40), session(50)];
    const { deps, saved } = makeDeps({
      listSessions: vi.fn().mockResolvedValue(sessions),
      worthMining: (s) => s.id !== "s-40",
      mine,
      lock: openLock(),
    });

    const outcome = await runKnowledgeSync({ deps });

    expect(outcome.status).toBe("mined");
    expect(outcome.minedSessions).toBe(2);
    expect(outcome.trivialSessions).toBe(1);
    const batch = mine.mock.calls[0][0] as AgentSession[];
    expect(batch.map((s) => s.id)).toEqual(["s-50", "s-30"]);
    // Watermark covers the trivial session too — it is never revisited.
    expect(saved[0].watermark).toBe(session(30).updated);
  });

  it("logs one line per mined session for status views to pick up", async () => {
    mockLoggerDebug.mockClear();
    const mine = vi.fn().mockResolvedValue(minerResult());
    const { deps } = makeMiningDeps({
      listSessions: vi.fn().mockResolvedValue([session(30), session(50)]),
      mine,
      lock: openLock(),
    });

    await runKnowledgeSync({ deps });

    const logged = mockLoggerDebug.mock.calls.map((c) => c.join(" ")).join("\n");
    expect(logged).toContain("mined session claude/s-50");
    expect(logged).toContain("mined session claude/s-30");
  });

  it("persists mined-session history and the all-time count in state", async () => {
    const mine = vi.fn().mockResolvedValue(minerResult());
    const { deps, saved } = makeMiningDeps({
      listSessions: vi
        .fn()
        .mockResolvedValue([session(30), { ...session(50), project: "dosu-cli" }]),
      loadState: () => ({
        schema_version: 1,
        watermark: null,
        consecutive_failures: 0,
        mined_sessions: [{ at: "2026-08-25T10:00:00.000Z", session: "cursor/earlier" }],
        total_mined: 5,
      }),
      mine,
      lock: openLock(),
    });

    await runKnowledgeSync({ deps });

    // New records append to the existing history, oldest first.
    expect(saved[0].mined_sessions?.map((r) => r.session)).toEqual([
      "cursor/earlier",
      "claude/s-50",
      "claude/s-30",
    ]);
    // The session's project is recorded when the scanner knew it.
    expect(saved[0].mined_sessions?.find((r) => r.session === "claude/s-50")?.project).toBe(
      "dosu-cli",
    );
    expect(
      saved[0].mined_sessions?.find((r) => r.session === "claude/s-30")?.project,
    ).toBeUndefined();
    expect(saved[0].total_mined).toBe(7);
  });

  it("accumulates all-time note and learning-token analytics on completed runs", async () => {
    const mine = vi.fn().mockResolvedValue(minerResult({ notesWritten: 3 }));
    const { deps, saved } = makeMiningDeps({
      listSessions: vi.fn().mockResolvedValue([session(30), session(50)]),
      loadState: () => ({
        schema_version: 1,
        watermark: null,
        consecutive_failures: 0,
        total_notes: 4,
        total_learning_tokens: 10_000,
      }),
      sessionTokens: () => 5_000,
      mine,
      lock: openLock(),
    });

    await runKnowledgeSync({ deps });

    expect(saved[0].total_notes).toBe(7);
    expect(saved[0].total_learning_tokens).toBe(20_000);
  });

  it("defaults the token estimator, degrading to zero for unreadable sessions", async () => {
    const mine = vi.fn().mockResolvedValue(minerResult());
    const { deps, saved } = makeMiningDeps({
      // session() paths do not exist on disk: the default chars÷4 estimator
      // must degrade to 0 instead of throwing.
      listSessions: vi.fn().mockResolvedValue([session(30)]),
      mine,
      lock: openLock(),
    });

    await runKnowledgeSync({ deps });

    expect(saved[0].total_learning_tokens).toBe(0);
    expect(saved[0].total_notes).toBe(2);
  });

  it("advances the watermark without a gateway run when everything is trivial", async () => {
    const mine = vi.fn();
    const { deps, saved } = makeDeps({
      listSessions: vi.fn().mockResolvedValue([session(30), session(40)]),
      worthMining: () => false,
      mine,
      lock: openLock(),
    });

    const outcome = await runKnowledgeSync({ deps });

    expect(outcome.status).toBe("nothing-new");
    expect(outcome.trivialSessions).toBe(2);
    expect(mine).not.toHaveBeenCalled();
    expect(saved[0].watermark).toBe(session(30).updated);
    expect(saved[0].consecutive_failures).toBe(0);
  });

  it("keeps examining past trivial sessions until the batch is full", async () => {
    const mine = vi.fn().mockResolvedValue(minerResult());
    // 8 ready; every second one trivial. Batch should fill with 4 worthy,
    // having examined all 8.
    const sessions = Array.from({ length: 8 }, (_, i) => session(30 + i * 10));
    const { deps, saved } = makeDeps({
      listSessions: vi.fn().mockResolvedValue(sessions),
      worthMining: (s) => Number.parseInt(s.id.slice(2), 10) % 20 === 10, // s-30, s-50, s-70, s-90
      mine,
      lock: openLock(),
    });

    const outcome = await runKnowledgeSync({ deps });

    expect(outcome.minedSessions).toBe(4);
    expect(outcome.trivialSessions).toBe(4);
    expect(saved[0].watermark).toBe(session(30).updated);
  });
});
