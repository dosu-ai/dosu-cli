import { describe, expect, it, vi } from "vitest";
import type { AgentSession } from "../sessions/scan";
import type { SyncLock } from "./lock";
import { runKnowledgeSync, SHIP_BATCH_LIMIT, type ShipSessionResult, type SyncDeps } from "./sync";
import { backoffUntil, type SyncState } from "./watermark";

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

function state(overrides: Partial<SyncState> = {}): SyncState {
  return { schema_version: 2, watermark: null, consecutive_failures: 0, ...overrides };
}

function openLock(): SyncLock {
  return { acquire: () => true, release: vi.fn() };
}

/** Ships every session, one task per session, in the order given. */
function shipAll(): NonNullable<SyncDeps["ship"]> {
  return vi.fn(async (sessions: AgentSession[]) =>
    sessions.map<ShipSessionResult>((s) => ({
      session: s,
      outcome: "shipped",
      taskId: `task-${s.id}`,
      sessionUrl: `https://app/memories/sessions/${s.id}`,
    })),
  );
}

function makeDeps(overrides: Partial<SyncDeps> = {}): { deps: SyncDeps; saved: SyncState[] } {
  const saved: SyncState[] = [];
  const deps: SyncDeps = {
    listSessions: vi.fn().mockResolvedValue([]),
    loadState: () => state(),
    saveState: (s) => saved.push(s),
    // Tests use fake paths: neither local filter can read them.
    worthShipping: () => true,
    isIncognito: () => false,
    isScratch: () => false,
    lock: openLock(),
    now: () => NOW,
    ...overrides,
  };
  return { deps, saved };
}

describe("runKnowledgeSync gate", () => {
  it("reports a backlog of completed sessions when there is no ship step", async () => {
    const { deps, saved } = makeDeps({
      listSessions: vi.fn().mockResolvedValue([session(60), session(30), session(1)]),
    });

    const outcome = await runKnowledgeSync({ deps });

    expect(outcome.status).toBe("backlog");
    expect(outcome.readySessions).toBe(2);
    expect(outcome.inFlightSessions).toBe(1);
    expect(outcome.sessions.map((s) => s.id)).toEqual(["s-60", "s-30"]);
    // Counting the backlog (setup's offer) must never move progress.
    expect(saved).toEqual([]);
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
    const unknown = session(40); // directory unresolvable → "(unknown)"
    const { deps } = makeDeps({
      loadState: () => state({ project_filter: ["/repo/dosu-cli"] }),
      listSessions: vi.fn().mockResolvedValue([inScope, outScope, unknown]),
      resolveProjectDir: (s) => (s.project ? `/repo/${s.project}` : null),
    });

    const outcome = await runKnowledgeSync({ deps });

    expect(outcome.sessions.map((s) => s.id)).toEqual([inScope.id]);
  });

  it("reports nothing-new when the gate is empty", async () => {
    const { deps } = makeDeps({ ship: shipAll() });
    const outcome = await runKnowledgeSync({ deps });
    expect(outcome.status).toBe("nothing-new");
    expect(deps.ship).not.toHaveBeenCalled();
  });

  it("accepts a synchronous session lister (the default scanner)", async () => {
    const { deps } = makeDeps({ listSessions: () => [session(60)] });
    const outcome = await runKnowledgeSync({ deps });
    expect(outcome.readySessions).toBe(1);
  });

  it("returns an error outcome and increments failures when the scan fails", async () => {
    const { deps, saved } = makeDeps({
      listSessions: vi.fn().mockRejectedValue(new Error("scan exploded")),
      loadState: () => state({ consecutive_failures: 1 }),
    });

    const outcome = await runKnowledgeSync({ deps });

    expect(outcome.status).toBe("error");
    expect(outcome.error).toContain("scan exploded");
    expect(saved[0].consecutive_failures).toBe(2);
  });

  it("survives a failing saveState on the error path", async () => {
    const { deps } = makeDeps({
      listSessions: vi.fn().mockRejectedValue(new Error("boom")),
      saveState: () => {
        throw new Error("disk full");
      },
    });
    expect((await runKnowledgeSync({ deps })).status).toBe("error");
  });
});

describe("runKnowledgeSync switches", () => {
  it("does nothing, not even a scan, once the user opted out", async () => {
    const { deps } = makeDeps({
      loadState: () => state({ ship_transcripts: false }),
      listSessions: vi.fn().mockResolvedValue([session(60)]),
      ship: shipAll(),
    });

    const outcome = await runKnowledgeSync({ deps });

    expect(outcome.status).toBe("disabled");
    expect(deps.listSessions).not.toHaveBeenCalled();
    expect(deps.ship).not.toHaveBeenCalled();
  });

  it("ships by default, with no opt-in recorded", async () => {
    const { deps } = makeDeps({
      listSessions: vi.fn().mockResolvedValue([session(60)]),
      ship: shipAll(),
    });
    expect((await runKnowledgeSync({ deps })).status).toBe("shipped");
  });

  it("quiet runs skip while backoff is in force, before any scan", async () => {
    const { deps } = makeDeps({
      loadState: () =>
        state({
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
      loadState: () =>
        state({
          last_attempt_at: new Date(NOW.getTime() - 16 * 60 * 1000).toISOString(),
          consecutive_failures: 1,
        }),
    });
    expect((await runKnowledgeSync({ quiet: true, deps })).status).toBe("nothing-new");
  });

  it("manual runs ignore backoff", async () => {
    const { deps } = makeDeps({
      loadState: () =>
        state({
          last_attempt_at: new Date(NOW.getTime() - 60 * 1000).toISOString(),
          consecutive_failures: 5,
        }),
    });
    expect((await runKnowledgeSync({ deps })).status).toBe("nothing-new");
  });

  it("quiet runs skip while paused, before any scan", async () => {
    const { deps } = makeDeps({ loadState: () => state({ paused: true }) });

    const outcome = await runKnowledgeSync({ quiet: true, deps });

    expect(outcome.status).toBe("skipped-paused");
    expect(deps.listSessions).not.toHaveBeenCalled();
  });

  it("a manual run acts as resume: the next state save drops the flag", async () => {
    const { deps, saved } = makeDeps({
      loadState: () => state({ paused: true }),
      listSessions: vi.fn().mockResolvedValue([session(60)]),
      ship: shipAll(),
    });

    await runKnowledgeSync({ deps });

    expect(saved.at(-1)?.paused).toBeUndefined();
  });
});

describe("runKnowledgeSync scan scope", () => {
  const window = new Date(NOW.getTime() - 30 * 24 * 60 * 60 * 1000).toISOString();

  it("hook runs scan the last 30 days, capped at 200 sessions", async () => {
    mockScanSessions.mockReset().mockReturnValue([]);
    const { deps } = makeDeps({ listSessions: undefined });

    await runKnowledgeSync({ deps });

    const arg = mockScanSessions.mock.calls[0][0] as { since: Date; limit?: number };
    expect(arg.limit).toBe(200);
    expect(arg.since.toISOString()).toBe(window);
  });

  it("the first-time backfill covers the same 30 days with no count cap", async () => {
    mockScanSessions.mockReset().mockReturnValue([]);
    const { deps } = makeDeps({ listSessions: undefined });

    await runKnowledgeSync({ bootstrap: true, deps });

    const arg = mockScanSessions.mock.calls[0][0] as { since: Date; limit?: number };
    expect(arg.limit).toBeUndefined();
    expect(arg.since.toISOString()).toBe(window);
  });
});

describe("runKnowledgeSync shipping", () => {
  it("ships the backlog oldest-first and records each accepted task", async () => {
    const ship = shipAll();
    const { deps, saved } = makeDeps({
      listSessions: vi.fn().mockResolvedValue([session(30), session(90), session(60)]),
      ship,
    });

    const outcome = await runKnowledgeSync({ deps });

    expect(vi.mocked(ship).mock.calls[0][0].map((s) => s.id)).toEqual(["s-90", "s-60", "s-30"]);
    expect(outcome.status).toBe("shipped");
    expect(outcome.counts).toEqual({
      shipped: 3,
      incognito: 0,
      trivial: 0,
      scratch: 0,
      skipped: 0,
      failed: 0,
    });
    const last = saved.at(-1);
    expect(last?.watermark).toBe(session(30).updated);
    expect(last?.total_shipped).toBe(3);
    expect(last?.shipped_sessions?.map((r) => r.session)).toEqual([
      "claude/s-90",
      "claude/s-60",
      "claude/s-30",
    ]);
    expect(last?.shipped_sessions?.[0]).toMatchObject({
      task_id: "task-s-90",
      session_url: "https://app/memories/sessions/s-90",
    });
    expect(last?.consecutive_failures).toBe(0);
  });

  it("settles incognito and trivial sessions locally without uploading them", async () => {
    const ship = shipAll();
    const secret = session(90);
    const tiny = session(60);
    const { deps, saved } = makeDeps({
      listSessions: vi.fn().mockResolvedValue([session(30), tiny, secret]),
      isIncognito: (s) => s === secret,
      worthShipping: (s) => s !== tiny,
      ship,
    });

    const outcome = await runKnowledgeSync({ deps });

    expect(vi.mocked(ship).mock.calls[0][0]).toEqual([session(30)]);
    expect(outcome.counts).toMatchObject({ shipped: 1, incognito: 1, trivial: 1 });
    expect(saved.at(-1)?.watermark).toBe(session(30).updated);
  });

  it("never uploads sessions run in a temp dir (eval replays, scratch repros)", async () => {
    const ship = shipAll();
    const replay = session(60);
    const { deps, saved } = makeDeps({
      listSessions: vi.fn().mockResolvedValue([session(30), replay]),
      isScratch: (s) => s === replay,
      ship,
    });

    const outcome = await runKnowledgeSync({ deps });

    expect(vi.mocked(ship).mock.calls[0][0]).toEqual([session(30)]);
    expect(outcome.counts).toMatchObject({ shipped: 1, scratch: 1 });
    expect(saved.at(-1)?.watermark).toBe(session(30).updated);
  });

  it("moves the watermark past a batch of only local skips without calling the ship step", async () => {
    const ship = shipAll();
    const { deps, saved } = makeDeps({
      listSessions: vi.fn().mockResolvedValue([session(30), session(60)]),
      worthShipping: () => false,
      ship,
    });

    const outcome = await runKnowledgeSync({ deps });

    expect(ship).not.toHaveBeenCalled();
    expect(outcome.status).toBe("shipped");
    expect(outcome.settledSessions).toBe(2);
    expect(saved.at(-1)?.watermark).toBe(session(30).updated);
  });

  it("stops at a failure: backs off and never moves past the session to retry", async () => {
    const older = session(90);
    const failing = session(60);
    const { deps, saved } = makeDeps({
      listSessions: vi.fn().mockResolvedValue([session(30), failing, older]),
      ship: vi.fn(
        async (): Promise<ShipSessionResult[]> => [
          { session: older, outcome: "shipped", taskId: "t1" },
          { session: failing, outcome: "failed", message: "502 Bad Gateway" },
        ],
      ),
    });

    const outcome = await runKnowledgeSync({ deps });

    expect(outcome.status).toBe("ship-failed");
    expect(outcome.error).toBe("502 Bad Gateway");
    expect(outcome.counts).toMatchObject({ shipped: 1, failed: 1 });
    const last = saved.at(-1) as SyncState;
    expect(last.watermark).toBe(older.updated);
    expect(last.consecutive_failures).toBe(1);
    expect(backoffUntil(last)?.toISOString()).toBe(
      new Date(NOW.getTime() + 15 * 60 * 1000).toISOString(),
    );
  });

  it("a trivial session after a failure is not settled past it", async () => {
    const failing = session(90);
    const tiny = session(60);
    const { deps, saved } = makeDeps({
      loadState: () => state({ watermark: "2026-08-01T00:00:00.000Z" }),
      listSessions: vi.fn().mockResolvedValue([tiny, failing]),
      worthShipping: (s) => s !== tiny,
      ship: vi.fn(
        async (): Promise<ShipSessionResult[]> => [
          { session: failing, outcome: "failed", message: "down" },
        ],
      ),
    });

    await runKnowledgeSync({ deps });

    expect(saved.at(-1)?.watermark).toBe("2026-08-01T00:00:00.000Z");
  });

  it("backend-rejected sessions advance the watermark without a recorded task", async () => {
    const rejected = session(60);
    const { deps, saved } = makeDeps({
      listSessions: vi.fn().mockResolvedValue([rejected]),
      ship: vi.fn(
        async (): Promise<ShipSessionResult[]> => [
          { session: rejected, outcome: "skipped", message: "413" },
        ],
      ),
    });

    const outcome = await runKnowledgeSync({ deps });

    expect(outcome.counts).toMatchObject({ skipped: 1 });
    expect(saved.at(-1)?.watermark).toBe(rejected.updated);
    expect(saved.at(-1)?.shipped_sessions).toEqual([]);
  });

  it("a throwing ship step counts as one failed attempt instead of crashing the sync", async () => {
    const { deps, saved } = makeDeps({
      listSessions: vi.fn().mockResolvedValue([session(60)]),
      ship: vi.fn().mockRejectedValue(new Error("bug")),
    });

    const outcome = await runKnowledgeSync({ deps });

    expect(outcome.status).toBe("ship-failed");
    expect(saved.at(-1)?.consecutive_failures).toBe(1);
    expect(saved.at(-1)?.watermark).toBeNull();
  });

  it("ships at most SHIP_BATCH_LIMIT sessions per run, oldest first", async () => {
    const sessions = Array.from({ length: SHIP_BATCH_LIMIT + 5 }, (_, i) => session(30 + i));
    const ship = shipAll();
    const { deps } = makeDeps({ listSessions: vi.fn().mockResolvedValue(sessions), ship });

    const outcome = await runKnowledgeSync({ deps });

    const batch = vi.mocked(ship).mock.calls[0][0];
    expect(batch).toHaveLength(SHIP_BATCH_LIMIT);
    expect(batch[0].id).toBe(`s-${30 + SHIP_BATCH_LIMIT + 4}`);
    expect(outcome.readySessions).toBe(SHIP_BATCH_LIMIT + 5);
    expect(outcome.settledSessions).toBe(SHIP_BATCH_LIMIT);
  });

  it("skips without touching state when another run holds the lock", async () => {
    const { deps, saved } = makeDeps({
      listSessions: vi.fn().mockResolvedValue([session(60)]),
      ship: shipAll(),
      lock: { acquire: () => false, release: vi.fn() },
    });

    const outcome = await runKnowledgeSync({ deps });

    expect(outcome.status).toBe("skipped-lock");
    expect(deps.ship).not.toHaveBeenCalled();
    expect(saved).toEqual([]);
  });

  it("releases the lock after shipping", async () => {
    const lock = openLock();
    const { deps } = makeDeps({
      listSessions: vi.fn().mockResolvedValue([session(60)]),
      ship: shipAll(),
      lock,
    });
    await runKnowledgeSync({ deps });
    expect(lock.release).toHaveBeenCalled();
  });

  it("stamps the run baseline, keeping it across same-pid batches", async () => {
    const { deps, saved } = makeDeps({
      loadState: () => state({ total_shipped: 5 }),
      listSessions: vi.fn().mockResolvedValue([session(60)]),
      ship: shipAll(),
    });
    await runKnowledgeSync({ deps });
    expect(saved.at(-1)?.run).toMatchObject({ pid: process.pid, baseline_shipped: 5 });

    const carried = saved.at(-1) as SyncState;
    const again = makeDeps({
      loadState: () => ({ ...carried }),
      listSessions: vi.fn().mockResolvedValue([session(30)]),
      ship: shipAll(),
    });
    await runKnowledgeSync({ deps: again.deps });
    expect(again.saved.at(-1)?.run?.baseline_shipped).toBe(5);
    expect(again.saved.at(-1)?.total_shipped).toBe(7);
  });
});
