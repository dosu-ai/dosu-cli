import { mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import type { AgentSession } from "../sessions/scan";
import type { SyncLock } from "./lock";
import { backoffUntil, emptySyncState, type LedgerEntry, type SyncState } from "./state";
import {
  ENDED_LOCK_WAIT_MS,
  runKnowledgeSync,
  SHIP_BATCH_LIMIT,
  type ShipSessionResult,
  type SyncDeps,
} from "./sync";

const mockLoggerDebug = vi.hoisted(() => vi.fn());
vi.mock("../debug/logger", () => ({
  logger: { debug: mockLoggerDebug, info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

const mockScanSessions = vi.hoisted(() => vi.fn());
vi.mock("../sessions/scan", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../sessions/scan")>()),
  scanAgentSessions: (...args: unknown[]) => mockScanSessions(...args),
}));

const mockCreateResolver = vi.hoisted(() => vi.fn());
vi.mock("../sessions/project-dir", () => ({
  createProjectDirResolver: (...args: unknown[]) => mockCreateResolver(...args),
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

const CLI = "1.2.3";

function state(overrides: Partial<SyncState> = {}): SyncState {
  return { ...emptySyncState(), ...overrides };
}

/** A ledger answer for `s` as it is now. */
function settled(
  s: AgentSession,
  overrides: Partial<LedgerEntry> = {},
): Record<string, LedgerEntry> {
  return {
    [`${s.harness}/${s.id}`]: {
      updated: s.updated,
      outcome: "shipped",
      at: NOW.toISOString(),
      cli_version: CLI,
      ...overrides,
    },
  };
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
    lock: openLock(),
    locator: { resolve: () => "/repo/dosu-cli", resolveRepo: () => DOSU_CLI },
    now: () => NOW,
    cliVersion: CLI,
    ...overrides,
  };
  return { deps, saved };
}

const DOSU_CLI = "github.com/dosu-ai/dosu-cli";

/** Sessions sit in `/repo/<project>`; project "dosu-cli" is DOSU_CLI, no project is no repo. */
const projectLocator = {
  resolve: (s: AgentSession) => (s.project ? `/repo/${s.project}` : null),
  resolveRepo: (s: AgentSession) =>
    s.project ? (s.project === "dosu-cli" ? DOSU_CLI : `github.com/x/${s.project}`) : null,
};

/** A Claude Code transcript under `dir`, outside anything the (faked) scan lists. */
function outsideTranscript(dir: string, id: string, mtime: Date = NOW): string {
  const project = join(dir, "relocated-config", "projects", "-work-app");
  mkdirSync(project, { recursive: true });
  const path = join(project, `${id}.jsonl`);
  writeFileSync(path, "{}\n");
  utimesSync(path, mtime, mtime);
  return path;
}

/** A state file in memory: what each run saves, the next run loads. */
function stateStore(initial: SyncState = state()) {
  let current = structuredClone(initial);
  return {
    loadState: () => structuredClone(current),
    saveState: (next: SyncState) => {
      current = structuredClone(next);
    },
    get: () => current,
  };
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
    expect(logged).toContain("gate: 12 ready, 0 in flight (0 already settled)");
    expect(logged).toContain("claude/s-30");
    expect(logged).toContain("(+2 more)");
  });

  it("gates out sessions outside the repo filter", async () => {
    const inScope = { ...session(60), project: "dosu-cli" };
    const outScope = { ...session(30), project: "other" };
    const { deps } = makeDeps({
      loadState: () => state({ repo_filter: [DOSU_CLI] }),
      listSessions: vi.fn().mockResolvedValue([inScope, outScope]),
      locator: projectLocator,
    });

    const outcome = await runKnowledgeSync({ deps });

    expect(outcome.sessions.map((s) => s.id)).toEqual([inScope.id]);
  });

  it("studies sessions outside a git repo when no repo filter is set", async () => {
    const inRepo = { ...session(60), project: "other" };
    const noRepo = session(40);
    const { deps } = makeDeps({
      listSessions: vi.fn().mockResolvedValue([inRepo, noRepo]),
      locator: projectLocator,
    });

    const outcome = await runKnowledgeSync({ deps });

    expect(outcome.sessions.map((s) => [s.id, s.repo])).toEqual([
      [inRepo.id, "github.com/x/other"],
      [noRepo.id, undefined],
    ]);
  });

  it("leaves sessions outside a git repo out of a repo filter", async () => {
    const inRepo = { ...session(60), project: "dosu-cli" };
    const { deps } = makeDeps({
      loadState: () => state({ repo_filter: [DOSU_CLI] }),
      listSessions: vi.fn().mockResolvedValue([inRepo, session(40)]),
      locator: projectLocator,
    });

    const outcome = await runKnowledgeSync({ deps });

    expect(outcome.sessions.map((s) => s.id)).toEqual([inRepo.id]);
  });

  it("converts a legacy folder scope to the repos its sessions ran in and persists it", async () => {
    mockScanSessions
      .mockReset()
      .mockReturnValue([
        { ...session(90), project: "dosu-cli" },
        { ...session(95), project: "other" },
        session(99),
      ]);
    const inScope = { ...session(60), project: "dosu-cli" };
    const outScope = { ...session(30), project: "other" };
    const { deps, saved } = makeDeps({
      loadState: () => state({ project_filter: ["/repo/dosu-cli", "(unknown)"] }),
      listSessions: vi.fn().mockResolvedValue([inScope, outScope]),
      locator: projectLocator,
    });

    const outcome = await runKnowledgeSync({ deps });

    expect(outcome.sessions.map((s) => s.id)).toEqual([inScope.id]);
    expect(saved[0].repo_filter).toEqual([DOSU_CLI]);
    expect(saved[0].project_filter).toBeUndefined();
  });

  it("a legacy folder scope with no repos in it studies nothing", async () => {
    mockScanSessions.mockReset().mockReturnValue([session(99)]);
    const { deps, saved } = makeDeps({
      loadState: () => state({ project_filter: ["(unknown)"] }),
      listSessions: vi.fn().mockResolvedValue([{ ...session(60), project: "dosu-cli" }]),
      locator: projectLocator,
    });

    const outcome = await runKnowledgeSync({ deps });

    expect(outcome.status).toBe("nothing-new");
    expect(saved[0].repo_filter).toEqual([]);
  });

  it("drops an empty legacy folder scope and studies every repo", async () => {
    const inRepo = { ...session(60), project: "dosu-cli" };
    const { deps, saved } = makeDeps({
      loadState: () => state({ project_filter: [] }),
      listSessions: vi.fn().mockResolvedValue([inRepo]),
      locator: projectLocator,
    });

    const outcome = await runKnowledgeSync({ deps });

    expect(outcome.sessions.map((s) => s.id)).toEqual([inRepo.id]);
    expect(saved[0].repo_filter).toBeUndefined();
    expect(saved[0].project_filter).toBeUndefined();
  });

  it("resolves repos with the on-disk resolver by default and flushes its cache", async () => {
    const flush = vi.fn();
    mockCreateResolver.mockReset().mockReturnValue({ ...projectLocator, flush });
    const inRepo = { ...session(60), project: "dosu-cli" };
    const { deps } = makeDeps({
      listSessions: vi.fn().mockResolvedValue([inRepo, session(40)]),
      locator: undefined,
    });

    const outcome = await runKnowledgeSync({ deps });

    expect(outcome.sessions.map((s) => s.repo)).toEqual([DOSU_CLI, undefined]);
    expect(flush).toHaveBeenCalledOnce();
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

  it("under backoff, a quiet run still tries the session a hook just ended, and only that", async () => {
    const justEnded = session(0);
    const ship = shipAll();
    const { deps, saved } = makeDeps({
      loadState: () =>
        state({
          last_attempt_at: new Date(NOW.getTime() - 60 * 1000).toISOString(),
          consecutive_failures: 1,
        }),
      listSessions: vi.fn().mockResolvedValue([justEnded, session(60)]),
      ship,
    });

    const outcome = await runKnowledgeSync({
      quiet: true,
      ended: [{ harness: "claude", id: justEnded.id }],
      deps,
    });

    expect(outcome.status).toBe("shipped");
    expect(vi.mocked(ship).mock.calls[0][0].map((s) => s.id)).toEqual([justEnded.id]);
    // It got through, so the backend is back: the backlog resumes with the next hook.
    expect(saved.at(-1)?.consecutive_failures).toBe(0);
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

  it("a paused hook run ships nothing, but remembers an ended session the scan cannot see", async () => {
    const dir = mkdtempSync(join(tmpdir(), "dosu-ended-"));
    try {
      const path = outsideTranscript(dir, "far-away");
      const ship = shipAll();
      const { deps, saved } = makeDeps({ loadState: () => state({ paused: true }), ship });

      const outcome = await runKnowledgeSync({
        quiet: true,
        ended: [{ harness: "claude", id: "far-away", path }],
        deps,
      });

      expect(outcome.status).toBe("skipped-paused");
      expect(ship).not.toHaveBeenCalled();
      expect(saved.at(-1)?.outside_sessions).toEqual({ "claude/far-away": path });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
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

  it("hook runs scan the whole last 30 days with no count cap", async () => {
    mockScanSessions.mockReset().mockReturnValue([]);
    const { deps } = makeDeps({ listSessions: undefined });

    await runKnowledgeSync({ quiet: true, deps });

    const arg = mockScanSessions.mock.calls[0][0] as { since: Date; limit?: number };
    expect(arg.limit).toBeUndefined();
    expect(arg.since.toISOString()).toBe(window);
  });
});

describe("runKnowledgeSync shipping", () => {
  it("ships the backlog oldest-first and settles each accepted task in the ledger", async () => {
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
      unsupported: 0,
      rejected: 0,
      failed: 0,
    });
    const last = saved.at(-1) as SyncState;
    expect(last.total_shipped).toBe(3);
    expect(last.sessions["claude/s-90"]).toEqual({
      updated: session(90).updated,
      outcome: "shipped",
      at: NOW.toISOString(),
      cli_version: CLI,
      task_id: "task-s-90",
      session_url: "https://app/memories/sessions/s-90",
    });
    expect(Object.keys(last.sessions).sort()).toEqual([
      "claude/s-30",
      "claude/s-60",
      "claude/s-90",
    ]);
    expect(last.consecutive_failures).toBe(0);
  });

  it("records the project key each session shipped under", async () => {
    const { deps, saved } = makeDeps({
      listSessions: vi.fn().mockResolvedValue([{ ...session(60), project: "-Users-me-widget" }]),
      ship: vi.fn(async (sessions: AgentSession[]) =>
        sessions.map<ShipSessionResult>((s) => ({
          session: s,
          outcome: "shipped",
          taskId: "t1",
          project: "github.com/acme/widget",
        })),
      ),
    });

    await runKnowledgeSync({ deps });

    expect(saved.at(-1)?.sessions["claude/s-60"]).toMatchObject({
      project: "github.com/acme/widget",
      // The scanner's slug, so history views can find the transcript again for its title.
      workspace: "-Users-me-widget",
    });
  });

  it("never ships a settled session again until it changes", async () => {
    const done = session(90);
    const grown = session(60);
    const ship = shipAll();
    const { deps } = makeDeps({
      loadState: () =>
        state({
          sessions: {
            ...settled(done),
            ...settled(grown, { updated: session(120).updated }),
          },
        }),
      listSessions: vi.fn().mockResolvedValue([done, grown]),
      ship,
    });

    const outcome = await runKnowledgeSync({ deps });

    expect(outcome.readySessions).toBe(1);
    expect(vi.mocked(ship).mock.calls[0][0].map((s) => s.id)).toEqual([grown.id]);
  });

  it("an older session passed over never hides behind newer settled ones", async () => {
    // The watermark bug: a session older than everything shipped was gone for good.
    const straggler = session(600);
    const ship = shipAll();
    const { deps } = makeDeps({
      loadState: () => state({ sessions: { ...settled(session(30)), ...settled(session(60)) } }),
      listSessions: vi.fn().mockResolvedValue([session(30), session(60), straggler]),
      ship,
    });

    await runKnowledgeSync({ deps });

    expect(vi.mocked(ship).mock.calls[0][0].map((s) => s.id)).toEqual([straggler.id]);
  });

  it("settles what the ship step passed over: incognito and trivial are answers, not failures", async () => {
    const secret = session(90);
    const tiny = session(60);
    const { deps, saved } = makeDeps({
      listSessions: vi.fn().mockResolvedValue([session(30), tiny, secret]),
      ship: vi.fn(
        async (): Promise<ShipSessionResult[]> => [
          { session: secret, outcome: "incognito" },
          { session: tiny, outcome: "trivial" },
          { session: session(30), outcome: "shipped", taskId: "t" },
        ],
      ),
    });

    const outcome = await runKnowledgeSync({ deps });

    expect(outcome.status).toBe("shipped");
    expect(outcome.settledSessions).toBe(3);
    expect(outcome.counts).toMatchObject({ shipped: 1, incognito: 1, trivial: 1, failed: 0 });
    const ledger = (saved.at(-1) as SyncState).sessions;
    expect(ledger["claude/s-90"]).toMatchObject({ outcome: "incognito", cli_version: CLI });
    expect(ledger["claude/s-60"]).toMatchObject({ outcome: "trivial", cli_version: CLI });
    expect(ledger["claude/s-60"].task_id).toBeUndefined();
  });

  it("remembers how much of each session shipped, and hands it to the ship step next time", async () => {
    const grown = session(60);
    const ship = vi.fn(async (sessions: AgentSession[], _shipped?: (s: AgentSession) => unknown) =>
      sessions.map<ShipSessionResult>((s) => ({
        session: s,
        outcome: "shipped",
        taskId: "t2",
        records: 9,
        prefixSha256: "hash-9",
      })),
    );
    const { deps, saved } = makeDeps({
      loadState: () =>
        state({
          sessions: settled(grown, {
            updated: session(120).updated,
            records: 4,
            prefix_sha256: "hash-4",
          }),
        }),
      listSessions: vi.fn().mockResolvedValue([grown]),
      ship,
    });

    await runKnowledgeSync({ deps });

    const shippedOf = ship.mock.calls[0][1] ?? (() => "not passed");
    expect(shippedOf(grown)).toEqual({ records: 4, prefix_sha256: "hash-4" });
    expect(shippedOf(session(1))).toBeUndefined();
    expect(saved.at(-1)?.sessions["claude/s-60"]).toMatchObject({
      outcome: "shipped",
      updated: grown.updated,
      records: 9,
      prefix_sha256: "hash-9",
      task_id: "t2",
    });
  });

  it("a shipped session whose new tail is trivial stays shipped, and settled", async () => {
    const grown = session(60);
    const before = settled(grown, {
      updated: session(120).updated,
      at: "2026-08-25T09:00:00.000Z",
      task_id: "t1",
      records: 4,
      prefix_sha256: "hash-4",
    });
    const { deps, saved } = makeDeps({
      loadState: () => state({ sessions: before }),
      listSessions: vi.fn().mockResolvedValue([grown]),
      ship: vi.fn(
        async (): Promise<ShipSessionResult[]> => [{ session: grown, outcome: "trivial" }],
      ),
    });

    const outcome = await runKnowledgeSync({ deps });

    expect(outcome.counts).toMatchObject({ trivial: 1 });
    // Still the first shipment's record, now answering for the current contents.
    expect(saved.at(-1)?.sessions["claude/s-60"]).toEqual({
      ...before["claude/s-60"],
      updated: grown.updated,
    });
  });

  it("a migrated shipped session that grew by too little stays shipped", async () => {
    const grown = session(60);
    const seeded = settled(grown, { updated: session(120).updated, task_id: "t0", seeded: true });
    const { deps, saved } = makeDeps({
      loadState: () => state({ sessions: seeded }),
      listSessions: vi.fn().mockResolvedValue([grown]),
      ship: vi.fn(
        async (): Promise<ShipSessionResult[]> => [{ session: grown, outcome: "trivial" }],
      ),
    });

    await runKnowledgeSync({ deps });

    expect(saved.at(-1)?.sessions["claude/s-60"]).toEqual({
      ...seeded["claude/s-60"],
      updated: grown.updated,
    });
  });

  it("a refused tail keeps what already shipped, so a retry can send just the tail", async () => {
    const grown = session(60);
    const { deps, saved } = makeDeps({
      loadState: () =>
        state({
          sessions: settled(grown, {
            updated: session(120).updated,
            task_id: "t1",
            records: 4,
            prefix_sha256: "hash-4",
          }),
        }),
      listSessions: vi.fn().mockResolvedValue([grown]),
      ship: vi.fn(
        async (): Promise<ShipSessionResult[]> => [
          { session: grown, outcome: "rejected", httpStatus: 413, message: "too big" },
        ],
      ),
    });

    await runKnowledgeSync({ deps });

    const entry = saved.at(-1)?.sessions["claude/s-60"];
    expect(entry).toMatchObject({ outcome: "rejected", records: 4, prefix_sha256: "hash-4" });
    expect(entry?.task_id).toBeUndefined();
  });

  it("a newer CLI reconsiders what an older one passed over", async () => {
    const tiny = session(60);
    const ship = shipAll();
    const { deps } = makeDeps({
      loadState: () =>
        state({ sessions: settled(tiny, { outcome: "trivial", cli_version: "0.0.1" }) }),
      listSessions: vi.fn().mockResolvedValue([tiny]),
      ship,
    });

    await runKnowledgeSync({ deps });

    expect(ship).toHaveBeenCalledOnce();
  });

  it("stops at a failure: backs off, and the failed session stays pending", async () => {
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
    expect(Object.keys(last.sessions)).toEqual(["claude/s-90"]);
    expect(last.consecutive_failures).toBe(1);
    expect(backoffUntil(last)?.toISOString()).toBe(
      new Date(NOW.getTime() + 15 * 60 * 1000).toISOString(),
    );
  });

  it("rejected and unsupported sessions are settled and visible, never failures", async () => {
    const rejected = session(90);
    const unsupported = session(60);
    const { deps, saved } = makeDeps({
      loadState: () => state({ consecutive_failures: 2 }),
      listSessions: vi.fn().mockResolvedValue([rejected, unsupported]),
      ship: vi.fn(
        async (): Promise<ShipSessionResult[]> => [
          { session: rejected, outcome: "rejected", httpStatus: 413, message: "too big" },
          { session: unsupported, outcome: "unsupported", message: "no normalizer" },
        ],
      ),
    });

    const outcome = await runKnowledgeSync({ deps });

    expect(outcome.status).toBe("shipped");
    expect(outcome.counts).toMatchObject({ rejected: 1, unsupported: 1, failed: 0 });
    const last = saved.at(-1) as SyncState;
    // A rejection is not a failure: backoff clears instead of stalling every other harness.
    expect(last.consecutive_failures).toBe(0);
    expect(last.sessions["claude/s-90"]).toMatchObject({
      outcome: "rejected",
      http_status: 413,
      message: "too big",
    });
    expect(last.sessions["claude/s-60"]).toMatchObject({
      outcome: "unsupported",
      message: "no normalizer",
    });
    expect(last.sessions["claude/s-90"].task_id).toBeUndefined();
  });

  it("--retry-rejected ships what the backend refused before", async () => {
    const refused = session(60);
    const ship = shipAll();
    const ledger = settled(refused, {
      outcome: "rejected",
      http_status: 422,
      at: "2026-08-24T00:00:00.000Z",
    });
    const { deps } = makeDeps({
      loadState: () => state({ sessions: ledger }),
      listSessions: vi.fn().mockResolvedValue([refused]),
      ship,
    });

    expect((await runKnowledgeSync({ deps })).status).toBe("nothing-new");
    expect(ship).not.toHaveBeenCalled();

    await runKnowledgeSync({ deps, retryRejectedBefore: NOW });
    expect(ship).toHaveBeenCalledOnce();
  });

  it("a throwing ship step counts as one failed attempt instead of crashing the sync", async () => {
    const { deps, saved } = makeDeps({
      listSessions: vi.fn().mockResolvedValue([session(60)]),
      ship: vi.fn().mockRejectedValue(new Error("bug")),
    });

    const outcome = await runKnowledgeSync({ deps });

    expect(outcome.status).toBe("ship-failed");
    expect(saved.at(-1)?.consecutive_failures).toBe(1);
    expect(saved.at(-1)?.sessions).toEqual({});
  });

  it("re-reads the ledger under the lock: what another run just settled is not shipped twice", async () => {
    const a = session(90);
    const b = session(60);
    const ship = shipAll();
    let reads = 0;
    const { deps } = makeDeps({
      // The first read (before the lock) predates the other run's save; later reads see it.
      loadState: () => (reads++ === 0 ? state() : state({ sessions: settled(a) })),
      listSessions: vi.fn().mockResolvedValue([a, b]),
      ship,
    });

    await runKnowledgeSync({ deps });

    expect(vi.mocked(ship).mock.calls[0][0].map((s) => s.id)).toEqual([b.id]);
  });

  it("reports nothing new when another run settled the whole backlog meanwhile", async () => {
    const a = session(90);
    let reads = 0;
    const { deps, saved } = makeDeps({
      loadState: () => (reads++ === 0 ? state() : state({ sessions: settled(a) })),
      listSessions: vi.fn().mockResolvedValue([a]),
      ship: shipAll(),
    });

    const outcome = await runKnowledgeSync({ deps });

    expect(outcome.status).toBe("nothing-new");
    expect(deps.ship).not.toHaveBeenCalled();
    expect(saved).toEqual([]);
  });

  it("saves onto a fresh read, so a switch flipped mid-run survives", async () => {
    let reads = 0;
    const { deps, saved } = makeDeps({
      loadState: () => (reads++ < 2 ? state() : state({ ship_transcripts: false })),
      listSessions: vi.fn().mockResolvedValue([session(60)]),
      ship: shipAll(),
    });

    await runKnowledgeSync({ deps });

    expect(saved.at(-1)?.ship_transcripts).toBe(false);
    expect(saved.at(-1)?.sessions["claude/s-60"]).toBeDefined();
  });

  it("prunes entries for sessions a week past the scan window", async () => {
    const old = new Date(NOW.getTime() - 38 * 24 * 60 * 60 * 1000).toISOString();
    const recent = new Date(NOW.getTime() - 36 * 24 * 60 * 60 * 1000).toISOString();
    const entry = (updated: string): LedgerEntry => ({
      updated,
      outcome: "trivial",
      at: updated,
      cli_version: CLI,
    });
    const { deps, saved } = makeDeps({
      loadState: () =>
        state({ sessions: { "claude/old": entry(old), "claude/recent": entry(recent) } }),
      listSessions: vi.fn().mockResolvedValue([session(60)]),
      ship: shipAll(),
    });

    await runKnowledgeSync({ deps });

    expect(Object.keys(saved.at(-1)?.sessions ?? {}).sort()).toEqual([
      "claude/recent",
      "claude/s-60",
    ]);
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

describe("runKnowledgeSync with a session a hook says just ended", () => {
  const justEnded = session(1);
  const stillOpen = { ...session(2), id: "other-live" };
  const backlog = session(60);

  it("ships it now, ahead of the backlog, while other fresh sessions wait out the quiet period", async () => {
    const ship = shipAll();
    const { deps } = makeDeps({
      listSessions: vi.fn().mockResolvedValue([justEnded, stillOpen, backlog]),
      ship,
    });

    const outcome = await runKnowledgeSync({
      quiet: true,
      ended: [{ harness: "claude", id: justEnded.id }],
      deps,
    });

    expect(vi.mocked(ship).mock.calls[0][0].map((s) => s.id)).toEqual([justEnded.id, backlog.id]);
    expect(outcome).toMatchObject({ readySessions: 2, inFlightSessions: 1 });
  });

  it("recognizes it by its transcript path alone", async () => {
    const ship = shipAll();
    const { deps } = makeDeps({ listSessions: vi.fn().mockResolvedValue([justEnded]), ship });

    await runKnowledgeSync({ ended: [{ path: justEnded.path }], deps });

    expect(ship).toHaveBeenCalledOnce();
  });

  it("finds it by its transcript when it lives outside the scanned roots", async () => {
    const dir = mkdtempSync(join(tmpdir(), "dosu-ended-"));
    try {
      const project = join(dir, "relocated-config", "projects", "-work-app");
      mkdirSync(project, { recursive: true });
      const path = join(project, "far-away.jsonl");
      writeFileSync(path, "{}\n");
      utimesSync(path, NOW, NOW);
      const ship = shipAll();
      const { deps } = makeDeps({ listSessions: vi.fn().mockResolvedValue([]), ship });

      await runKnowledgeSync({ ended: [{ harness: "claude", id: "far-away", path }], deps });

      expect(vi.mocked(ship).mock.calls[0][0]).toEqual([
        {
          id: "far-away",
          harness: "claude",
          path,
          project: "-work-app",
          updated: NOW.toISOString(),
          repo: DOSU_CLI,
        },
      ]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("keeps retrying one outside the scanned roots until it ships, and after", async () => {
    const dir = mkdtempSync(join(tmpdir(), "dosu-ended-"));
    try {
      // Ended ten minutes ago, so a later run's quiet period no longer holds it.
      const path = outsideTranscript(dir, "far-away", new Date(NOW.getTime() - 10 * 60_000));
      const store = stateStore();
      const failing = vi.fn(async (sessions: AgentSession[]) => [
        { session: sessions[0], outcome: "failed" as const, message: "HTTP 503" },
      ]);
      const ended = [{ harness: "claude" as const, id: "far-away", path }];
      await runKnowledgeSync({ ended, deps: makeDeps({ ...store, ship: failing }).deps });

      // A later run that no hook told about it still finds it.
      const ship = shipAll();
      const later = await runKnowledgeSync({ deps: makeDeps({ ...store, ship }).deps });

      expect(later.status).toBe("shipped");
      expect(vi.mocked(ship).mock.calls[0][0].map((s) => s.id)).toEqual(["far-away"]);
      // Still remembered once shipped: a resumed session ships its tail from there.
      expect(store.get().outside_sessions).toEqual({ "claude/far-away": path });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("remembers one this run's scan found only through a variable later runs may lack", async () => {
    const dir = mkdtempSync(join(tmpdir(), "dosu-ended-"));
    try {
      // Listed because this hook's agent exported CLAUDE_CONFIG_DIR; a shell's sync would not.
      const path = outsideTranscript(dir, "relocated");
      const listed = {
        id: "relocated",
        harness: "claude" as const,
        path,
        updated: NOW.toISOString(),
      };
      const store = stateStore();

      await runKnowledgeSync({
        ended: [{ harness: "claude", id: "relocated", path }],
        deps: makeDeps({ ...store, listSessions: vi.fn().mockResolvedValue([listed]) }).deps,
      });

      expect(store.get().outside_sessions).toEqual({ "claude/relocated": path });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("forgets a remembered transcript once it is gone, past the window, or where every scan looks", async () => {
    const dir = mkdtempSync(join(tmpdir(), "dosu-ended-"));
    vi.stubEnv("HOME", dir);
    try {
      const gone = join(dir, "gone.jsonl");
      const old = outsideTranscript(dir, "old", new Date(NOW.getTime() - 31 * 24 * 60 * 60_000));
      const kept = outsideTranscript(dir, "kept");
      // Under ~/.claude/projects, which every scan lists, whatever its environment.
      const home = join(dir, ".claude", "projects", "-work-app");
      mkdirSync(home, { recursive: true });
      const atHome = join(home, "at-home.jsonl");
      writeFileSync(atHome, "{}\n");
      const store = stateStore(
        state({
          outside_sessions: {
            "claude/gone": gone,
            "claude/old": old,
            "claude/at-home": atHome,
            "claude/kept": kept,
            "bogus/x": kept,
          },
        }),
      );

      await runKnowledgeSync({ deps: makeDeps(store).deps });

      expect(store.get().outside_sessions).toEqual({ "claude/kept": kept });
    } finally {
      vi.unstubAllEnvs();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("records where it lives onto a fresh read, keeping what a concurrent run settled", async () => {
    const dir = mkdtempSync(join(tmpdir(), "dosu-ended-"));
    try {
      const path = outsideTranscript(dir, "far-away");
      const concurrent = settled(session(90));
      let reads = 0;
      const { deps, saved } = makeDeps({
        // Another run settles a session while this one scans.
        loadState: () => (++reads === 1 ? state() : state({ sessions: concurrent })),
      });

      await runKnowledgeSync({ ended: [{ harness: "claude", id: "far-away", path }], deps });

      expect(saved[0]).toMatchObject({
        sessions: concurrent,
        outside_sessions: { "claude/far-away": path },
      });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("does not ship it again when the ledger already answers for it", async () => {
    const ship = shipAll();
    const { deps } = makeDeps({
      loadState: () => state({ sessions: settled(justEnded) }),
      listSessions: vi.fn().mockResolvedValue([justEnded]),
      ship,
    });

    const outcome = await runKnowledgeSync({
      ended: [{ harness: "claude", id: justEnded.id }],
      deps,
    });

    expect(outcome.status).toBe("nothing-new");
    expect(ship).not.toHaveBeenCalled();
  });

  it("waits for a run holding the lock instead of dropping the session", async () => {
    let attempts = 0;
    const sleep = vi.fn(async () => {});
    const ship = shipAll();
    const { deps } = makeDeps({
      listSessions: vi.fn().mockResolvedValue([justEnded]),
      lock: { acquire: () => ++attempts > 3, release: vi.fn() },
      sleep,
      ship,
    });

    const outcome = await runKnowledgeSync({
      quiet: true,
      ended: [{ harness: "claude", id: justEnded.id }],
      deps,
    });

    expect(outcome.status).toBe("shipped");
    expect(sleep).toHaveBeenCalledTimes(3);
  });

  it("gives up waiting after a bound, leaving the session for the next run", async () => {
    const sleep = vi.fn(async (_ms: number) => {});
    const ship = shipAll();
    const { deps } = makeDeps({
      listSessions: vi.fn().mockResolvedValue([justEnded]),
      lock: { acquire: () => false, release: vi.fn() },
      sleep,
      ship,
    });

    const outcome = await runKnowledgeSync({
      quiet: true,
      ended: [{ harness: "claude", id: justEnded.id }],
      deps,
    });

    expect(outcome.status).toBe("skipped-lock");
    expect(ship).not.toHaveBeenCalled();
    const waited = sleep.mock.calls.reduce((total, [ms]) => total + ms, 0);
    expect(waited).toBeGreaterThanOrEqual(ENDED_LOCK_WAIT_MS);
  });
});
