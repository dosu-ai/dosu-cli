import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { AgentSession } from "../sessions/scan";
import {
  backoffUntil,
  DEFAULT_QUIET_PERIOD_MS,
  filterSessionsByRepo,
  gateSessions,
  isShippingEnabled,
  isUnderDir,
  loadSyncState,
  resetSyncState,
  type SyncState,
  saveSyncState,
  setShipTranscripts,
  setSyncPaused,
  skipBacklog,
  studyRepoFilter,
  syncStatePath,
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

function writeRaw(raw: unknown): void {
  writeFileSync(syncStatePath(configDir), JSON.stringify(raw));
}

describe("loadSyncState / saveSyncState", () => {
  it("returns an empty state when no file exists", () => {
    const state = loadSyncState(configDir);
    expect(state.schema_version).toBe(2);
    expect(state.watermark).toBeNull();
    expect(state.consecutive_failures).toBe(0);
  });

  it("round-trips state through disk", () => {
    const state: SyncState = {
      schema_version: 2,
      watermark: "2026-08-25T11:00:00Z",
      last_attempt_at: "2026-08-25T11:05:00Z",
      consecutive_failures: 2,
      shipped_sessions: [
        {
          at: "2026-08-25T11:04:00Z",
          session: "claude/abc",
          task_id: "task-1",
          session_url: "https://app/memories/sessions/abc",
          project: "dosu",
        },
      ],
      total_shipped: 12,
      run: { pid: 4321, started_at: "2026-08-25T11:03:00Z", baseline_shipped: 7 },
      project_filter: ["/Users/me/proj"],
      paused: true,
      ship_transcripts: false,
    };
    saveSyncState(state, configDir);
    expect(loadSyncState(configDir)).toEqual(state);
  });

  it("drops a malformed run record", () => {
    writeRaw({
      schema_version: 2,
      watermark: null,
      consecutive_failures: 0,
      run: { pid: "not-a-pid", started_at: "2026-08-25T11:03:00Z", baseline_shipped: -1 },
    });
    expect(loadSyncState(configDir).run).toBeUndefined();
  });

  it("writes owner-only files with no temp residue", () => {
    saveSyncState({ schema_version: 2, watermark: null, consecutive_failures: 0 }, configDir);
    const content = readFileSync(syncStatePath(configDir), "utf-8");
    expect(JSON.parse(content).schema_version).toBe(2);
  });

  it("treats a corrupt file as empty state", () => {
    writeFileSync(syncStatePath(configDir), "{nope");
    expect(loadSyncState(configDir).watermark).toBeNull();
  });

  it("treats an unknown schema_version as empty state", () => {
    writeRaw({ schema_version: 99, watermark: "2026-01-01T00:00:00Z" });
    expect(loadSyncState(configDir).watermark).toBeNull();
  });

  it("normalizes malformed fields and drops malformed shipped-session records", () => {
    writeRaw({
      schema_version: 2,
      watermark: 42,
      consecutive_failures: -3,
      shipped_sessions: [
        { at: "2026-08-25T11:04:00Z", session: "claude/abc", task_id: "task-1", project: 42 },
        { at: "2026-08-25T11:04:00Z", session: "claude/no-task" },
        "junk",
        null,
      ],
      total_shipped: "many",
    });
    const state = loadSyncState(configDir);
    expect(state.watermark).toBeNull();
    expect(state.consecutive_failures).toBe(0);
    expect(state.shipped_sessions).toEqual([
      { at: "2026-08-25T11:04:00Z", session: "claude/abc", task_id: "task-1" },
    ]);
    // A bad counter falls back to what the surviving history proves.
    expect(state.total_shipped).toBe(1);
  });
});

describe("migration from the studying-era state (schema 1)", () => {
  const v1 = {
    schema_version: 1,
    // The learner's progress: memory has never seen these sessions, so it must not carry over.
    watermark: "2026-09-01T00:00:00Z",
    consecutive_failures: 4,
    last_attempt_at: "2026-09-01T00:05:00Z",
    mined_sessions: [{ at: "2026-09-01T00:00:00Z", session: "cursor/abc" }],
    total_mined: 40,
    total_notes: 12,
    last_refusal: { at: "2026-09-01T00:05:00Z", outcome: "credit_limit", message: "out" },
    repo_filter: ["github.com/me/proj"],
    project_filter: ["/Users/me/proj"],
    paused: true,
  };

  it("keeps shipping progress and user settings, dropping the learner's", () => {
    writeRaw({
      ...v1,
      ship_transcripts: true,
      ship: {
        watermark: "2026-08-20T00:00:00Z",
        last_attempt_at: "2026-08-20T00:01:00Z",
        consecutive_failures: 1,
        shipped_sessions: [{ at: "2026-08-20T00:00:00Z", session: "claude/x", task_id: "t" }],
        total_shipped: 9,
      },
    });
    expect(loadSyncState(configDir)).toEqual({
      schema_version: 2,
      watermark: "2026-08-20T00:00:00Z",
      last_attempt_at: "2026-08-20T00:01:00Z",
      consecutive_failures: 1,
      shipped_sessions: [{ at: "2026-08-20T00:00:00Z", session: "claude/x", task_id: "t" }],
      total_shipped: 9,
      repo_filter: ["github.com/me/proj"],
      project_filter: ["/Users/me/proj"],
      paused: true,
    });
  });

  it("starts shipping from scratch when the install never shipped", () => {
    writeRaw(v1);
    const state = loadSyncState(configDir);
    expect(state.watermark).toBeNull();
    expect(state.consecutive_failures).toBe(0);
    expect(state.total_shipped).toBe(0);
    // Shipping was opt-in under schema 1; absent now means on.
    expect(isShippingEnabled(state)).toBe(true);
    expect(state.repo_filter).toEqual(["github.com/me/proj"]);
    expect(state.project_filter).toEqual(["/Users/me/proj"]);
  });
});

describe("study scope", () => {
  it("round-trips both filters through disk and drops non-string entries", () => {
    saveSyncState(
      {
        schema_version: 2,
        watermark: null,
        consecutive_failures: 0,
        repo_filter: ["github.com/dosu-ai/dosu-cli"],
        project_filter: ["/repo/dosu-cli"],
      },
      configDir,
    );
    expect(loadSyncState(configDir).repo_filter).toEqual(["github.com/dosu-ai/dosu-cli"]);
    expect(loadSyncState(configDir).project_filter).toEqual(["/repo/dosu-cli"]);

    writeFileSync(
      syncStatePath(configDir),
      JSON.stringify({
        schema_version: 2,
        watermark: null,
        consecutive_failures: 0,
        repo_filter: ["github.com/a/b", 42, null],
        project_filter: ["dosu", 42, null],
      }),
    );
    expect(loadSyncState(configDir).repo_filter).toEqual(["github.com/a/b"]);
    expect(loadSyncState(configDir).project_filter).toEqual(["dosu"]);
  });

  it("filterSessionsByRepo keeps every session without a filter and only picked repos with one", () => {
    const cli = session({ id: "cli", project: "github.com/dosu-ai/dosu-cli" });
    const app = session({ id: "app", project: "github.com/dosu-ai/dosu" });
    const loose = session({ id: "loose" });
    const repoOf = (s: AgentSession) => s.project ?? null;

    expect(filterSessionsByRepo([cli, app, loose], null, repoOf)).toEqual([
      { ...cli, repo: "github.com/dosu-ai/dosu-cli" },
      { ...app, repo: "github.com/dosu-ai/dosu" },
      loose,
    ]);
    expect(filterSessionsByRepo([cli, app, loose], ["github.com/dosu-ai/dosu"], repoOf)).toEqual([
      { ...app, repo: "github.com/dosu-ai/dosu" },
    ]);
    expect(filterSessionsByRepo([cli, app, loose], [], repoOf)).toEqual([]);
  });

  it("studyRepoFilter prefers the repo filter and is null with no scope", () => {
    const locator = { resolve: () => "/x", resolveRepo: () => "github.com/a/b" };
    const list = () => [session()];
    expect(studyRepoFilter({ repo_filter: ["github.com/c/d"] }, list, locator)).toEqual([
      "github.com/c/d",
    ]);
    expect(studyRepoFilter({}, list, locator)).toBeNull();
    expect(studyRepoFilter({ project_filter: [] }, list, locator)).toBeNull();
  });

  it("studyRepoFilter maps a legacy folder scope to the sorted repos of its sessions", () => {
    const sessions = [
      session({ id: "a", project: "/work/dosu-cli/src" }),
      session({ id: "b", project: "/work/dosu" }),
      session({ id: "c", project: "/work/dosu-cli-docs" }),
      session({ id: "d", project: "/work/scratch" }),
      session({ id: "e" }),
    ];
    const repos: Record<string, string | null> = {
      a: "github.com/dosu-ai/dosu-cli",
      b: "github.com/dosu-ai/dosu",
      c: "github.com/dosu-ai/docs",
      d: null,
    };
    const locator = {
      resolve: (s: AgentSession) => s.project ?? null,
      resolveRepo: (s: AgentSession) => repos[s.id] ?? null,
    };

    expect(
      studyRepoFilter(
        { project_filter: ["/work/dosu-cli", "/work/dosu", "/work/scratch", "(unknown)"] },
        () => sessions,
        locator,
      ),
    ).toEqual(["github.com/dosu-ai/dosu", "github.com/dosu-ai/dosu-cli"]);
  });

  it("isUnderDir respects path boundaries and trailing slashes", () => {
    expect(isUnderDir("/a/b", "/a/b")).toBe(true);
    expect(isUnderDir("/a/b/c", "/a/b/")).toBe(true);
    expect(isUnderDir("/a/bc", "/a/b")).toBe(false);
  });
});

describe("backoffUntil", () => {
  it("returns null with no failures", () => {
    expect(
      backoffUntil({ schema_version: 2, watermark: null, consecutive_failures: 0 }),
    ).toBeNull();
  });

  it("returns null when there is no attempt timestamp", () => {
    expect(
      backoffUntil({ schema_version: 2, watermark: null, consecutive_failures: 3 }),
    ).toBeNull();
  });

  it("doubles the delay per failure starting at 15 minutes", () => {
    const base = Date.parse("2026-08-25T12:00:00Z");
    const state = (failures: number): SyncState => ({
      schema_version: 2,
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
      schema_version: 2,
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

describe("resetSyncState", () => {
  it("forgets shipping progress but keeps the filter, pause switch and opt-out", () => {
    saveSyncState(
      {
        schema_version: 2,
        watermark: "2026-09-02T23:00:00.000Z",
        last_attempt_at: "2026-09-02T23:05:00.000Z",
        consecutive_failures: 3,
        shipped_sessions: [{ at: "2026-09-02T23:00:00.000Z", session: "claude/abc", task_id: "t" }],
        total_shipped: 40,
        run: { pid: 1, started_at: "2026-09-02T23:00:00.000Z", baseline_shipped: 39 },
        repo_filter: ["github.com/me/proj"],
        project_filter: ["/Users/me/proj"],
        paused: true,
        ship_transcripts: false,
      },
      configDir,
    );

    resetSyncState(configDir);

    const state = loadSyncState(configDir);
    expect(state.watermark).toBeNull();
    expect(state.last_attempt_at).toBeUndefined();
    expect(state.consecutive_failures).toBe(0);
    expect(state.shipped_sessions).toEqual([]);
    expect(state.total_shipped).toBe(0);
    expect(state.run).toBeUndefined();
    expect(backoffUntil(state)).toBeNull();
    expect(state.repo_filter).toEqual(["github.com/me/proj"]);
    expect(state.project_filter).toEqual(["/Users/me/proj"]);
    expect(state.paused).toBe(true);
    expect(state.ship_transcripts).toBe(false);
  });

  it("writes a clean file when nothing was ever shipped", () => {
    resetSyncState(configDir);
    const raw = readFileSync(syncStatePath(configDir), "utf-8");
    expect(loadSyncState(configDir).watermark).toBeNull();
    expect(raw).not.toContain("paused");
    expect(raw).not.toContain("ship_transcripts");
  });
});

describe("skipBacklog", () => {
  it("moves the watermark to now so only later sessions ship, keeping the rest", () => {
    saveSyncState(
      {
        schema_version: 2,
        watermark: "2026-08-01T00:00:00.000Z",
        consecutive_failures: 0,
        total_shipped: 3,
        project_filter: ["/p"],
      },
      configDir,
    );

    skipBacklog(NOW, configDir);

    const state = loadSyncState(configDir);
    expect(state.watermark).toBe(NOW.toISOString());
    expect(state.total_shipped).toBe(3);
    expect(state.project_filter).toEqual(["/p"]);
  });

  it("never moves the watermark backwards", () => {
    saveSyncState(
      { schema_version: 2, watermark: "2026-09-01T00:00:00.000Z", consecutive_failures: 0 },
      configDir,
    );

    skipBacklog(NOW, configDir);

    expect(loadSyncState(configDir).watermark).toBe("2026-09-01T00:00:00.000Z");
  });
});

describe("setSyncPaused", () => {
  it("persists the pause flag and round-trips through load", () => {
    setSyncPaused(true, configDir);
    expect(loadSyncState(configDir).paused).toBe(true);
  });

  it("resume removes the key entirely instead of storing false", () => {
    setSyncPaused(true, configDir);
    setSyncPaused(false, configDir);
    expect(loadSyncState(configDir).paused).toBeUndefined();
    expect(readFileSync(syncStatePath(configDir), "utf-8")).not.toContain("paused");
  });

  it("pausing preserves the rest of the state", () => {
    saveSyncState(
      {
        schema_version: 2,
        watermark: "2026-09-02T23:00:00.000Z",
        consecutive_failures: 2,
        total_shipped: 7,
      },
      configDir,
    );
    setSyncPaused(true, configDir);
    const loaded = loadSyncState(configDir);
    expect(loaded.watermark).toBe("2026-09-02T23:00:00.000Z");
    expect(loaded.consecutive_failures).toBe(2);
    expect(loaded.total_shipped).toBe(7);
    expect(loaded.paused).toBe(true);
  });

  it("loadSyncState ignores non-boolean paused values", () => {
    writeRaw({ schema_version: 2, watermark: null, consecutive_failures: 0, paused: "yes" });
    expect(loadSyncState(configDir).paused).toBeUndefined();
  });
});

describe("transcript shipping switch", () => {
  it("is on by default", () => {
    expect(isShippingEnabled(loadSyncState(configDir))).toBe(true);
  });

  it("disable persists an explicit opt-out", () => {
    setShipTranscripts(false, configDir);
    expect(loadSyncState(configDir).ship_transcripts).toBe(false);
    expect(isShippingEnabled(loadSyncState(configDir))).toBe(false);
  });

  it("enable removes the key instead of storing true", () => {
    setShipTranscripts(false, configDir);
    setShipTranscripts(true, configDir);
    expect(isShippingEnabled(loadSyncState(configDir))).toBe(true);
    expect(readFileSync(syncStatePath(configDir), "utf-8")).not.toContain("ship_transcripts");
  });

  it("only a literal false opts out", () => {
    writeRaw({
      schema_version: 2,
      watermark: null,
      consecutive_failures: 0,
      ship_transcripts: "no",
    });
    expect(isShippingEnabled(loadSyncState(configDir))).toBe(true);
  });

  it("toggling preserves the rest of the state", () => {
    saveSyncState(
      { schema_version: 2, watermark: "2026-09-02T23:00:00.000Z", consecutive_failures: 2 },
      configDir,
    );
    setShipTranscripts(false, configDir);
    const loaded = loadSyncState(configDir);
    expect(loaded.watermark).toBe("2026-09-02T23:00:00.000Z");
    expect(loaded.consecutive_failures).toBe(2);
  });
});
