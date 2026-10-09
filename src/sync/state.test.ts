import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { sessionLineage } from "../sessions/lineage";
import type { AgentSession } from "../sessions/scan";
import {
  agentIncognitoEntry,
  backoffUntil,
  DEFAULT_QUIET_PERIOD_MS,
  emptySyncState,
  filterSessionsByRepo,
  gateSessions,
  isAgentIncognito,
  isPending,
  isShippingEnabled,
  isUnanswered,
  isUnderDir,
  type LedgerEntry,
  leaveIncognito,
  ledgerStamp,
  legacyPassedSessions,
  loadSyncState,
  outcomeCounts,
  pruneLedger,
  resetSyncState,
  type SyncState,
  saveSyncState,
  sealAgentSession,
  setAgentsIncognito,
  setShipTranscripts,
  setSyncPaused,
  settledSessions,
  shippedSessions,
  skipBacklog,
  studyRepoFilter,
  syncStatePath,
} from "./state";

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

const VERSION = "1.2.3";

function entry(overrides: Partial<LedgerEntry> = {}): LedgerEntry {
  return {
    updated: "2026-08-25T11:00:00.000Z",
    outcome: "shipped",
    at: "2026-08-25T11:06:00.000Z",
    cli_version: VERSION,
    ...overrides,
  };
}

describe("loadSyncState / saveSyncState", () => {
  it("returns an empty ledger when no file exists", () => {
    const state = loadSyncState(configDir);
    expect(state.schema_version).toBe(3);
    expect(state.sessions).toEqual({});
    expect(state.consecutive_failures).toBe(0);
  });

  it("round-trips state through disk", () => {
    const state: SyncState = {
      schema_version: 3,
      sessions: {
        "claude/abc": entry({
          task_id: "task-1",
          session_url: "https://app/memories/sessions/abc",
          project: "github.com/acme/widget",
          workspace: "-Users-me-widget",
          records: 42,
          prefix_sha256: "ab12",
        }),
        "codex/def": entry({
          outcome: "rejected",
          http_status: 413,
          message: "ingest rejected: HTTP 413",
        }),
        "claude/old": entry({ seeded: true }),
      },
      last_attempt_at: "2026-08-25T11:05:00Z",
      consecutive_failures: 2,
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
      schema_version: 3,
      sessions: {},
      consecutive_failures: 0,
      run: { pid: "not-a-pid", started_at: "2026-08-25T11:03:00Z", baseline_shipped: -1 },
    });
    expect(loadSyncState(configDir).run).toBeUndefined();
  });

  it("writes owner-only files with no temp residue", () => {
    saveSyncState(emptySyncState(), configDir);
    const content = readFileSync(syncStatePath(configDir), "utf-8");
    expect(JSON.parse(content).schema_version).toBe(3);
  });

  it("starts the ledger over for a schema_version it does not know", () => {
    writeRaw({ schema_version: 99, sessions: { "claude/x": entry() } });
    expect(loadSyncState(configDir)).toEqual(emptySyncState());
  });

  it("never widens what ships when it cannot read the schema: settings and seals stay", () => {
    // A newer CLI's file, read after a downgrade.
    const sealed = entry({ outcome: "incognito", by_agent: true, path: "/x.jsonl", message: "m" });
    writeRaw({
      schema_version: 99,
      sessions: { "claude/x": entry(), "codex/sealed": sealed },
      last_attempt_at: "2026-08-25T11:00:00Z",
      consecutive_failures: 4,
      repo_filter: ["github.com/o/private-only"],
      paused: true,
      ship_transcripts: false,
      incognito_agents: ["cursor", "claude", 7],
    });
    const { message: _, ...trimmed } = sealed;
    expect(loadSyncState(configDir)).toEqual({
      ...emptySyncState(),
      sessions: { "codex/sealed": trimmed },
      repo_filter: ["github.com/o/private-only"],
      paused: true,
      ship_transcripts: false,
      incognito_agents: ["claude", "cursor"],
    });
    writeRaw({ incognito_agents: ["codex"] });
    expect(loadSyncState(configDir)).toEqual({ ...emptySyncState(), incognito_agents: ["codex"] });
  });

  it("fails closed on a file it cannot parse, and never saves over it", () => {
    for (const text of ["{nope", '{"incognito_agents": ["claude",]}', "[]", "null"]) {
      writeFileSync(syncStatePath(configDir), text);
      const state = loadSyncState(configDir);
      // Shipping off, as whatever it said may have kept something out.
      expect(state).toEqual({
        ...emptySyncState(),
        ship_transcripts: false,
        unreadable: true,
      });
      expect(isShippingEnabled(state)).toBe(false);
      expect(() => setSyncPaused(true, configDir)).toThrow("could not be read");
      expect(() => setAgentsIncognito(["codex"], true, configDir)).toThrow("could not be read");
      expect(() => resetSyncState(configDir)).toThrow("fix or remove it");
      expect(readFileSync(syncStatePath(configDir), "utf-8")).toBe(text);
    }
  });

  it("normalizes malformed fields and drops malformed ledger entries", () => {
    writeRaw({
      schema_version: 3,
      consecutive_failures: -3,
      total_shipped: "many",
      sessions: {
        "claude/good": { ...entry(), project: 42, http_status: "x", seeded: "yes" },
        "claude/bad-outcome": entry({ outcome: "studied" as never }),
        "claude/no-version": { updated: "x", outcome: "trivial", at: "y" },
        "claude/junk": "junk",
      },
    });
    const state = loadSyncState(configDir);
    expect(state.consecutive_failures).toBe(0);
    expect(state.total_shipped).toBeUndefined();
    expect(state.sessions).toEqual({ "claude/good": entry() });
  });

  it("an entries object that is not an object reads as an empty ledger", () => {
    writeRaw({ schema_version: 3, sessions: ["claude/x"], consecutive_failures: 0 });
    expect(loadSyncState(configDir).sessions).toEqual({});
  });
});

describe("migration from the watermark state (schema 2)", () => {
  const v2 = {
    schema_version: 2,
    watermark: "2026-08-25T11:00:00Z",
    last_attempt_at: "2026-08-25T11:05:00Z",
    consecutive_failures: 1,
    shipped_sessions: [
      { at: "2026-08-20T00:00:00Z", session: "claude/x", task_id: "t1", project: "-Users-me-x" },
      {
        at: "2026-08-21T00:00:00Z",
        session: "codex/y",
        task_id: "t2",
        session_url: "u2",
        project: "-Users-me-y",
      },
      { at: "2026-08-22T00:00:00Z", session: "claude/x", task_id: "t3" },
      { at: "2026-08-22T00:00:00Z", session: "claude/no-task" },
      "junk",
    ],
    total_shipped: 40,
    repo_filter: ["github.com/me/proj"],
    paused: true,
    ship_transcripts: false,
    incognito_agents: ["codex"],
  };

  it("seeds the ledger with what shipped, drops the watermark, and keeps settings", () => {
    writeRaw(v2);

    expect(loadSyncState(configDir)).toEqual({
      schema_version: 3,
      sessions: {
        // A session shipped twice keeps its latest pass (whose record had no workspace slug).
        "claude/x": {
          updated: "2026-08-22T00:00:00Z",
          outcome: "shipped",
          at: "2026-08-22T00:00:00Z",
          cli_version: "migrated",
          task_id: "t3",
          seeded: true,
        },
        "codex/y": {
          updated: "2026-08-21T00:00:00Z",
          outcome: "shipped",
          at: "2026-08-21T00:00:00Z",
          cli_version: "migrated",
          task_id: "t2",
          session_url: "u2",
          workspace: "-Users-me-y",
          seeded: true,
        },
      },
      last_attempt_at: "2026-08-25T11:05:00Z",
      consecutive_failures: 1,
      total_shipped: 40,
      repo_filter: ["github.com/me/proj"],
      paused: true,
      ship_transcripts: false,
      incognito_agents: ["codex"],
    });
  });

  it("a seeded session stays settled until it changes after it shipped", () => {
    writeRaw(v2);
    const seeded = loadSyncState(configDir).sessions["claude/x"];
    const options = { cliVersion: VERSION };

    expect(isPending(session({ updated: "2026-08-21T23:00:00Z" }), seeded, options)).toBe(false);
    expect(isPending(session({ updated: "2026-08-23T00:00:00Z" }), seeded, options)).toBe(true);
  });

  it("counts the surviving history when the lifetime counter is unreadable", () => {
    writeRaw({ ...v2, total_shipped: "many" });
    expect(loadSyncState(configDir).total_shipped).toBe(3);
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
      schema_version: 3,
      sessions: {
        "claude/x": {
          updated: "2026-08-20T00:00:00Z",
          outcome: "shipped",
          at: "2026-08-20T00:00:00Z",
          cli_version: "migrated",
          task_id: "t",
          seeded: true,
        },
      },
      last_attempt_at: "2026-08-20T00:01:00Z",
      consecutive_failures: 1,
      total_shipped: 9,
      repo_filter: ["github.com/me/proj"],
      project_filter: ["/Users/me/proj"],
      paused: true,
    });
  });

  it("carries 0.66's per-agent incognito switch over, and the next save keeps it", () => {
    // As 0.66 wrote it: the list at the top level, and no `ship` block.
    writeRaw({ ...v1, incognito_agents: ["cursor", "claude", "cursor", 7] });
    expect(loadSyncState(configDir).incognito_agents).toEqual(["claude", "cursor"]);

    setSyncPaused(false, configDir);

    expect(loadSyncState(configDir).incognito_agents).toEqual(["claude", "cursor"]);
    const raw = JSON.parse(readFileSync(syncStatePath(configDir), "utf-8"));
    expect(raw.schema_version).toBe(3);
    expect(raw.incognito_agents).toEqual(["claude", "cursor"]);
  });

  it("keeps what 0.66's watermark passed over unstudied, for the first sync to settle", () => {
    // 0.66 passed an incognito agent's sessions by the watermark, and dropped the agent from the
    // list once the switch was off: nothing else says which those were.
    const v066 = {
      ...v1,
      watermark: "2026-10-06T12:00:00Z",
      mined_sessions: [{ at: "2026-10-06T12:00:00Z", session: "claude/studied" }, { at: "x" }],
    };
    writeRaw(v066);
    expect(loadSyncState(configDir).legacy_passed).toEqual({
      before: "2026-10-06T12:00:00Z",
      studied: ["claude/studied"],
    });
    // Kept until a sync settles it, through other saves and a clear.
    setSyncPaused(false, configDir);
    resetSyncState(configDir);
    expect(loadSyncState(configDir).legacy_passed?.before).toBe("2026-10-06T12:00:00Z");

    // Not from before 0.66 brought the switch, nor from beta's schema 1, which had none.
    writeRaw(v1);
    expect(loadSyncState(configDir).legacy_passed).toBeUndefined();
    writeRaw({ ...v066, ship: {} });
    expect(loadSyncState(configDir).legacy_passed).toBeUndefined();
  });

  it("drops an empty incognito list rather than storing it", () => {
    writeRaw({ ...v1, incognito_agents: [] });
    expect("incognito_agents" in loadSyncState(configDir)).toBe(false);
  });

  it("starts shipping from scratch when the install never shipped", () => {
    writeRaw(v1);
    const state = loadSyncState(configDir);
    expect(state.sessions).toEqual({});
    expect(state.consecutive_failures).toBe(0);
    expect(state.last_attempt_at).toBeUndefined();
    expect(state.total_shipped).toBe(0);
    // Shipping was opt-in under schema 1; absent now means on.
    expect(isShippingEnabled(state)).toBe(true);
    expect(state.repo_filter).toEqual(["github.com/me/proj"]);
    expect(state.project_filter).toEqual(["/Users/me/proj"]);
  });
});

describe("legacyPassedSessions", () => {
  it("names the unsettled, unstudied sessions the watermark passed since the switch existed", () => {
    const at = (id: string, updated: string) => session({ id, updated });
    const sessions = [
      at("passed", "2026-10-06T10:00:00Z"),
      at("studied", "2026-10-06T10:00:00Z"),
      at("settled", "2026-10-06T10:00:00Z"),
      at("before-the-switch", "2026-10-04T10:00:00Z"),
      at("since", "2026-10-07T10:00:00Z"),
    ];
    const state = {
      sessions: { "claude/settled": entry() },
      legacy_passed: { before: "2026-10-06T12:00:00Z", studied: ["claude/studied"] },
    };

    expect(legacyPassedSessions(sessions, state).map((s) => s.id)).toEqual(["passed"]);
    expect(legacyPassedSessions(sessions, { sessions: {} })).toEqual([]);
  });
});

describe("isPending", () => {
  const options = { cliVersion: VERSION };
  const s = session({ updated: "2026-08-25T11:00:00.000Z" });

  it("a session with no ledger entry, or whose contents changed, is pending", () => {
    expect(isPending(s, undefined, options)).toBe(true);
    expect(isPending(s, entry({ updated: "2026-08-25T10:00:00.000Z" }), options)).toBe(true);
    // Moving backwards counts too: only an exact match is an answer for these contents.
    expect(isPending(s, entry({ updated: "2026-08-25T12:00:00.000Z" }), options)).toBe(true);
  });

  it("compares instants, not spellings", () => {
    expect(isPending(s, entry({ updated: "2026-08-25T11:00:00Z" }), options)).toBe(false);
  });

  it("shipped and user-skipped sessions stay settled across CLI versions", () => {
    const newer = { cliVersion: "9.9.9" };
    expect(isPending(s, entry({ outcome: "shipped" }), newer)).toBe(false);
    expect(isPending(s, entry({ outcome: "skipped_by_user" }), newer)).toBe(false);
  });

  it("a passed-over session is reconsidered by a different CLI version", () => {
    for (const outcome of ["trivial", "incognito", "rejected", "unsupported"] as const) {
      expect(isPending(s, entry({ outcome }), options)).toBe(false);
      expect(isPending(s, entry({ outcome }), { cliVersion: "9.9.9" })).toBe(true);
    }
  });

  it("a session an agent's incognito switch settled is never pending again", () => {
    const off = entry({ outcome: "incognito", by_agent: true });
    expect(isPending(s, off, options)).toBe(false);
    // Not on a newer CLI, not once it was resumed, not on --retry-rejected.
    expect(isPending(s, off, { cliVersion: "9.9.9" })).toBe(false);
    expect(isPending({ ...s, updated: "2026-08-26T00:00:00.000Z" }, off, options)).toBe(false);
    const retry = { cliVersion: VERSION, retryRejectedBefore: new Date("2026-08-27T00:00:00Z") };
    expect(isPending(s, off, retry)).toBe(false);
  });

  it("--retry-rejected makes sessions refused before it started pending, and only those", () => {
    const retry = { cliVersion: VERSION, retryRejectedBefore: new Date("2026-08-25T12:00:00Z") };
    expect(isPending(s, entry({ outcome: "rejected" }), retry)).toBe(true);
    expect(isPending(s, entry({ outcome: "trivial" }), retry)).toBe(false);
    // Refused again during this run: not retried a second time.
    const refusedAgain = entry({ outcome: "rejected", at: "2026-08-25T12:01:00.000Z" });
    expect(isPending(s, refusedAgain, retry)).toBe(false);
  });
});

describe("isUnanswered", () => {
  const s = session({ updated: "2026-08-25T11:00:00.000Z" });

  it("holds for contents the ledger has no answer for, whatever CLI version answered before", () => {
    expect(isUnanswered(s, undefined)).toBe(true);
    expect(isUnanswered(s, entry({ updated: "2026-08-25T10:00:00.000Z" }))).toBe(true);
    // Passed over by another version, for these very contents: an answer all the same.
    for (const outcome of ["trivial", "rejected", "unsupported", "incognito"] as const) {
      expect(isUnanswered(s, entry({ outcome, cli_version: "0.0.1" }))).toBe(false);
    }
    expect(isUnanswered(s, entry({ outcome: "incognito", by_agent: true, updated: "x" }))).toBe(
      false,
    );
    expect(isUnanswered(s, entry({ seeded: true, updated: "2026-08-25T10:00:00.000Z" }))).toBe(
      true,
    );
    expect(isUnanswered(s, entry({ seeded: true, updated: "2026-08-25T12:00:00.000Z" }))).toBe(
      false,
    );
  });
});

describe("pruneLedger", () => {
  it("drops entries for sessions last updated before the cutoff", () => {
    const state: SyncState = {
      ...emptySyncState(),
      sessions: {
        "claude/old": entry({ updated: "2026-07-01T00:00:00.000Z" }),
        "claude/new": entry({ updated: "2026-08-20T00:00:00.000Z" }),
      },
    };
    pruneLedger(state, new Date("2026-08-01T00:00:00.000Z"));
    expect(Object.keys(state.sessions)).toEqual(["claude/new"]);
  });

  it("keeps an old entry whose session the scan still lists", () => {
    const state: SyncState = {
      ...emptySyncState(),
      sessions: {
        "claude/old": entry({ updated: "2026-07-01T00:00:00.000Z" }),
        "claude/resumed": entry({ updated: "2026-07-01T00:00:00.000Z" }),
      },
    };
    pruneLedger(state, new Date("2026-08-01T00:00:00.000Z"), new Set(["claude/resumed"]));
    expect(Object.keys(state.sessions)).toEqual(["claude/resumed"]);
  });

  it("keeps what the agents' switch settled while its transcript is on disk, however old", () => {
    // Nothing in the transcript records the switch: a resume months later must not ship it.
    const off = (path?: string) =>
      entry({ updated: "2026-07-01T00:00:00.000Z", outcome: "incognito", by_agent: true, path });
    const state: SyncState = {
      ...emptySyncState(),
      sessions: {
        "codex/kept": off("/sessions/kept.jsonl"),
        "claude/gone": off("/sessions/gone.jsonl"),
        "cursor/unknown": off(),
        "claude/marker": entry({ updated: "2026-07-01T00:00:00.000Z", outcome: "incognito" }),
      },
    };
    pruneLedger(state, new Date("2026-08-01T00:00:00.000Z"), new Set(), (path) =>
      path.endsWith("kept.jsonl"),
    );
    expect(Object.keys(state.sessions).sort()).toEqual(["codex/kept", "cursor/unknown"]);
  });
});

describe("ledger views", () => {
  const state: SyncState = {
    ...emptySyncState(),
    sessions: {
      "claude/b": entry({ at: "2026-08-25T12:00:00.000Z", task_id: "tb", project: "p" }),
      "claude/a": entry({ at: "2026-08-25T11:00:00.000Z", task_id: "ta", session_url: "u" }),
      "codex/r": entry({ outcome: "rejected", http_status: 422, message: "bad" }),
      "pi/u": entry({ outcome: "unsupported" }),
      "claude/t": entry({ outcome: "trivial" }),
    },
  };

  it("counts every outcome", () => {
    expect(outcomeCounts(state)).toEqual({
      shipped: 2,
      trivial: 1,
      incognito: 0,
      rejected: 1,
      unsupported: 1,
      skipped_by_user: 0,
    });
  });

  it("lists shipped sessions oldest first as history records", () => {
    expect(shippedSessions(state)).toEqual([
      { at: "2026-08-25T11:00:00.000Z", session: "claude/a", task_id: "ta", session_url: "u" },
      { at: "2026-08-25T12:00:00.000Z", session: "claude/b", task_id: "tb", project: "p" },
    ]);
  });

  it("lists the entries for one outcome with their keys", () => {
    expect(settledSessions(state, "rejected")).toEqual([
      { session: "codex/r", ...entry({ outcome: "rejected", http_status: 422, message: "bad" }) },
    ]);
  });

  it("stamps change whenever something settles or the ledger empties", () => {
    const before = ledgerStamp(state);
    const after: SyncState = {
      ...state,
      sessions: { ...state.sessions, "claude/z": entry({ at: "2026-08-26T00:00:00.000Z" }) },
    };
    expect(ledgerStamp(after)).not.toBe(before);
    expect(ledgerStamp(emptySyncState())).not.toBe(before);
  });
});

describe("study scope", () => {
  it("round-trips both filters through disk and drops non-string entries", () => {
    saveSyncState(
      {
        ...emptySyncState(),
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
        schema_version: 3,
        sessions: {},
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
    expect(backoffUntil(emptySyncState())).toBeNull();
  });

  it("returns null when there is no attempt timestamp", () => {
    expect(backoffUntil({ ...emptySyncState(), consecutive_failures: 3 })).toBeNull();
  });

  it("doubles the delay per failure starting at 15 minutes", () => {
    const base = Date.parse("2026-08-25T12:00:00Z");
    const state = (failures: number): SyncState => ({
      ...emptySyncState(),
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
      ...emptySyncState(),
      last_attempt_at: "2026-08-25T12:00:00Z",
      consecutive_failures: 20,
    });
    expect(until?.getTime()).toBe(base + 24 * 60 * 60 * 1000);
  });
});

describe("gateSessions", () => {
  const options = { cliVersion: VERSION, now: NOW };

  it("splits pending sessions on the quiet period, keeping the input order", () => {
    const fresh = session({ updated: new Date(NOW.getTime() - 60 * 1000).toISOString() });
    const settled = session({ updated: new Date(NOW.getTime() - 10 * 60 * 1000).toISOString() });

    const result = gateSessions(
      [fresh, settled],
      {},
      { ...options, quietPeriodMs: DEFAULT_QUIET_PERIOD_MS },
    );

    expect(result.ready.map((s) => s.id)).toEqual([settled.id]);
    expect(result.open.map((s) => s.id)).toEqual([fresh.id]);
  });

  it("passes over sessions the ledger already answered, however old or new", () => {
    const shipped = session({ updated: "2026-08-25T09:00:00Z" });
    const skippedOlder = session({ updated: "2026-08-25T08:00:00Z" });
    const unseen = session({ updated: "2026-08-25T07:00:00Z" });
    const ledger = {
      [`claude/${shipped.id}`]: entry({ updated: shipped.updated }),
      [`claude/${skippedOlder.id}`]: entry({ updated: skippedOlder.updated, outcome: "trivial" }),
    };

    const result = gateSessions([shipped, skippedOlder, unseen], ledger, options);

    // No high-water mark: an unseen session older than everything settled still ships.
    expect(result.ready.map((s) => s.id)).toEqual([unseen.id]);
  });

  it("ignores sessions with unparseable timestamps", () => {
    const broken = session({ updated: "not-a-date" });
    expect(gateSessions([broken], {}, options).ready).toHaveLength(0);
  });

  it("handles offset timestamps", () => {
    const offsetSession = session({ updated: "2026-08-25T04:00:00.758553246-07:00" });
    expect(gateSessions([offsetSession], {}, options).ready).toHaveLength(1);
  });
});

describe("resetSyncState", () => {
  it("forgets the ledger but keeps the filter, pause switch, opt-out and incognito agents", () => {
    saveSyncState(
      {
        schema_version: 3,
        sessions: { "claude/abc": entry({ task_id: "t" }) },
        last_attempt_at: "2026-09-02T23:05:00.000Z",
        consecutive_failures: 3,
        total_shipped: 40,
        run: { pid: 1, started_at: "2026-09-02T23:00:00.000Z", baseline_shipped: 39 },
        repo_filter: ["github.com/me/proj"],
        project_filter: ["/Users/me/proj"],
        paused: true,
        ship_transcripts: false,
        incognito_agents: ["cursor"],
        incognito_since: { cursor: "2026-09-01T00:00:00.000Z" },
      },
      configDir,
    );

    resetSyncState(configDir);

    const state = loadSyncState(configDir);
    expect(state.sessions).toEqual({});
    expect(state.last_attempt_at).toBeUndefined();
    expect(state.consecutive_failures).toBe(0);
    expect(state.total_shipped).toBeUndefined();
    expect(state.run).toBeUndefined();
    expect(backoffUntil(state)).toBeNull();
    expect(state.repo_filter).toEqual(["github.com/me/proj"]);
    expect(state.project_filter).toEqual(["/Users/me/proj"]);
    expect(state.paused).toBe(true);
    expect(state.ship_transcripts).toBe(false);
    expect(state.incognito_agents).toEqual(["cursor"]);
    expect(state.incognito_since).toEqual({ cursor: "2026-09-01T00:00:00.000Z" });
  });

  it("keeps the sessions an agent's incognito switch settled, trimmed to the answer", () => {
    const off = entry({
      outcome: "incognito",
      by_agent: true,
      parent: "p",
      message: "m",
      path: "/x/off.jsonl",
    });
    saveSyncState(
      {
        ...emptySyncState(),
        sessions: {
          "cursor/off": off,
          "claude/marker": entry({ outcome: "incognito" }),
          "claude/shipped": entry({ task_id: "t" }),
        },
      },
      configDir,
    );

    resetSyncState(configDir);

    const { message: _, ...trimmed } = off;
    expect(loadSyncState(configDir).sessions).toEqual({ "cursor/off": trimmed });
  });

  it("writes a clean file when nothing was ever shipped", () => {
    resetSyncState(configDir);
    const raw = readFileSync(syncStatePath(configDir), "utf-8");
    expect(loadSyncState(configDir)).toEqual(emptySyncState());
    expect(raw).not.toContain("paused");
    expect(raw).not.toContain("ship_transcripts");
  });
});

describe("outside_sessions", () => {
  it("survives a load and a reset, dropping malformed values", () => {
    writeRaw({
      schema_version: 3,
      sessions: {},
      consecutive_failures: 0,
      outside_sessions: { "claude/a": "/x/a.jsonl", "claude/b": 7 },
    });
    expect(loadSyncState(configDir).outside_sessions).toEqual({ "claude/a": "/x/a.jsonl" });

    resetSyncState(configDir);
    expect(loadSyncState(configDir).outside_sessions).toEqual({ "claude/a": "/x/a.jsonl" });
  });
});

describe("skipBacklog", () => {
  it("settles exactly the declined sessions as skipped by the user, keeping the rest", () => {
    saveSyncState(
      {
        ...emptySyncState(),
        sessions: { "claude/shipped": entry({ task_id: "t" }) },
        total_shipped: 3,
        project_filter: ["/p"],
      },
      configDir,
    );
    const declined = session({ id: "declined", updated: "2026-08-24T00:00:00.000Z" });

    skipBacklog([declined], VERSION, NOW, configDir);

    const state = loadSyncState(configDir);
    expect(state.sessions).toEqual({
      "claude/shipped": entry({ task_id: "t" }),
      "claude/declined": {
        updated: "2026-08-24T00:00:00.000Z",
        outcome: "skipped_by_user",
        at: NOW.toISOString(),
        cli_version: VERSION,
      },
    });
    expect(state.total_shipped).toBe(3);
    expect(state.project_filter).toEqual(["/p"]);
  });

  it("never overwrites a session the ledger already settled: a shipped one keeps its prefix", () => {
    const shipped = entry({ task_id: "t", records: 12, prefix_sha256: "abc" });
    saveSyncState({ ...emptySyncState(), sessions: { "claude/grown": shipped } }, configDir);

    skipBacklog(
      [session({ id: "grown", updated: "2026-08-26T00:00:00.000Z" })],
      VERSION,
      NOW,
      configDir,
    );

    expect(loadSyncState(configDir).sessions).toEqual({ "claude/grown": shipped });
  });

  it("settles a declined session of an incognito agent as its switch would", () => {
    saveSyncState({ ...emptySyncState(), incognito_agents: ["cursor"] }, configDir);
    const declined = session({ harness: "cursor", id: "c1", updated: "2026-08-24T00:00:00.000Z" });
    const subagent = session({ harness: "cursor", id: "c1-sub", parentId: "c1" });

    skipBacklog([declined, subagent], VERSION, NOW, configDir);

    expect(loadSyncState(configDir).sessions).toEqual({
      "cursor/c1": agentIncognitoEntry(declined, NOW.toISOString(), VERSION),
      "cursor/c1-sub": agentIncognitoEntry(subagent, NOW.toISOString(), VERSION),
    });
    expect(loadSyncState(configDir).sessions["cursor/c1-sub"]).toMatchObject({
      outcome: "incognito",
      by_agent: true,
      parent: "c1",
    });
  });

  it("settles a declined subagent of a session the switch settled the same way, once it is off", () => {
    const off = agentIncognitoEntry(session(), NOW.toISOString(), VERSION);
    saveSyncState({ ...emptySyncState(), sessions: { "cursor/c1": off } }, configDir);
    const subagent = session({ harness: "cursor", id: "c1-sub", parentId: "c1" });

    skipBacklog([subagent], VERSION, NOW, configDir);

    expect(loadSyncState(configDir).sessions["cursor/c1-sub"]).toEqual(
      agentIncognitoEntry(subagent, NOW.toISOString(), VERSION),
    );
  });

  it("a declined session ships once it changes, and never on a CLI upgrade alone", () => {
    const declined = session({ id: "declined", updated: "2026-08-24T00:00:00.000Z" });
    skipBacklog([declined], VERSION, NOW, configDir);
    const skipped = loadSyncState(configDir).sessions["claude/declined"];

    expect(isPending(declined, skipped, { cliVersion: "9.9.9" })).toBe(false);
    expect(
      isPending({ ...declined, updated: "2026-08-26T00:00:00.000Z" }, skipped, {
        cliVersion: VERSION,
      }),
    ).toBe(true);
  });
});

describe("setAgentsIncognito", () => {
  it("adds and removes agents, keeping the list sorted and deduplicated", () => {
    setAgentsIncognito(["cursor", "claude"], true, configDir);
    setAgentsIncognito(["cursor"], true, configDir);
    expect(loadSyncState(configDir).incognito_agents).toEqual(["claude", "cursor"]);

    setAgentsIncognito(["claude"], false, configDir);
    expect(loadSyncState(configDir).incognito_agents).toEqual(["cursor"]);
  });

  it("records when each agent went in, keeping the first time while it stays in", () => {
    writeRaw({
      ...emptySyncState(),
      incognito_agents: ["cursor"],
      incognito_since: { cursor: "2026-09-01T00:00:00.000Z", codex: "2026-09-02T00:00:00.000Z" },
    });
    // Only the listed agents' times are read, and only times.
    expect(loadSyncState(configDir).incognito_since).toEqual({
      cursor: "2026-09-01T00:00:00.000Z",
    });

    const before = Date.now();
    setAgentsIncognito(["cursor", "claude"], true, configDir);
    const since = loadSyncState(configDir).incognito_since ?? {};
    expect(since.cursor).toBe("2026-09-01T00:00:00.000Z");
    expect(Date.parse(since.claude)).toBeGreaterThanOrEqual(before);

    setAgentsIncognito(["cursor", "claude"], false, configDir);
    expect(loadSyncState(configDir).incognito_since).toBeUndefined();
  });

  it("drops the key once no agent is incognito, and keeps the rest of the state", () => {
    saveSyncState(
      { ...emptySyncState(), sessions: { "claude/abc": entry() }, total_shipped: 3 },
      configDir,
    );
    setAgentsIncognito(["codex"], true, configDir);
    setAgentsIncognito(["codex"], false, configDir);
    const state = loadSyncState(configDir);
    expect(state.sessions["claude/abc"]).toEqual(entry());
    expect(state.total_shipped).toBe(3);
    expect(readFileSync(syncStatePath(configDir), "utf-8")).not.toContain("incognito_agents");
  });

  it("ignores non-string entries in a hand-edited file", () => {
    writeRaw({ ...emptySyncState(), incognito_agents: ["cursor", 7] });
    expect(loadSyncState(configDir).incognito_agents).toEqual(["cursor"]);
  });
});

describe("isAgentIncognito", () => {
  const s = session({ harness: "cursor", id: "c1" });

  it("holds for every session of a listed agent", () => {
    expect(isAgentIncognito({ sessions: {}, incognito_agents: ["cursor"] }, s)).toBe(true);
    expect(isAgentIncognito({ sessions: {}, incognito_agents: ["claude"] }, s)).toBe(false);
    expect(isAgentIncognito({ sessions: {} }, s)).toBe(false);
  });

  it("keeps holding for a session the switch settled, once the switch is off", () => {
    const sessions = { "cursor/c1": entry({ outcome: "incognito", by_agent: true }) };
    expect(isAgentIncognito({ sessions }, s)).toBe(true);
    // A /dosu-incognito session is the transcript marker's to decide.
    expect(
      isAgentIncognito({ sessions: { "cursor/c1": entry({ outcome: "incognito" }) } }, s),
    ).toBe(false);
  });

  describe("for the subagents and forks of a session the switch settled", () => {
    const off = { "cursor/root": entry({ outcome: "incognito", by_agent: true }) };
    const root = session({ harness: "cursor", id: "root" });
    const child = session({ harness: "cursor", id: "child", parentId: "root" });
    const grandchild = session({ harness: "cursor", id: "grandchild", parentId: "child" });
    const fork = session({ harness: "cursor", id: "fork", forkOf: { id: "root", path: "/r" } });

    it("holds for its own subagents and forks", () => {
      expect(isAgentIncognito({ sessions: off }, child)).toBe(true);
      expect(isAgentIncognito({ sessions: off }, fork)).toBe(true);
      // Another agent's session of the same id is someone else's.
      expect(isAgentIncognito({ sessions: off }, { ...child, harness: "claude" })).toBe(false);
    });

    it("holds further down, through the scan or the ledger", () => {
      expect(isAgentIncognito({ sessions: off }, grandchild)).toBe(false);
      expect(
        isAgentIncognito({ sessions: off }, grandchild, sessionLineage([root, child, grandchild])),
      ).toBe(true);
      const recorded = {
        ...off,
        "cursor/child": entry({ outcome: "shipped", parent: "root" }),
      };
      expect(isAgentIncognito({ sessions: recorded }, grandchild)).toBe(true);
    });

    it("does not hold through a /dosu-incognito session, and ends on a cycle", () => {
      const marked = { "cursor/root": entry({ outcome: "incognito" }) };
      expect(isAgentIncognito({ sessions: marked }, child, sessionLineage([root, child]))).toBe(
        false,
      );
      const loop = session({ harness: "cursor", id: "a", parentId: "b" });
      const back = session({ harness: "cursor", id: "b", parentId: "a" });
      expect(isAgentIncognito({ sessions: {} }, loop, sessionLineage([loop, back]))).toBe(false);
    });
  });
});

describe("leaveIncognito", () => {
  const cursor = (id: string, overrides: Partial<AgentSession> = {}) =>
    session({ harness: "cursor", id, updated: "2026-08-25T11:00:00.000Z", ...overrides });

  it("seals what the agent ran while incognito that no sync settled, then takes it out", () => {
    const shipped = cursor("shipped");
    const grown = cursor("grown", { updated: "2026-08-25T11:30:00.000Z" });
    const unsettled = cursor("unsettled");
    const subagent = cursor("sub", { parentId: "unsettled" });
    // Quiet since before the agent went in: it never ran while incognito.
    const before = cursor("before", { updated: "2026-08-25T09:00:00.000Z" });
    const other = session({ id: "claude-1" });
    saveSyncState(
      {
        ...emptySyncState(),
        incognito_agents: ["claude", "cursor"],
        incognito_since: { cursor: "2026-08-25T10:00:00.000Z" },
        sessions: {
          "cursor/shipped": entry({ task_id: "t1" }),
          "cursor/grown": entry({ task_id: "t2", records: 3, prefix_sha256: "h" }),
        },
      },
      configDir,
    );
    const listSessions = vi.fn((_state: SyncState, _since: Date) => [
      shipped,
      grown,
      unsettled,
      subagent,
      before,
      other,
    ]);

    leaveIncognito(["cursor"], listSessions, VERSION, NOW, configDir);

    // Listed from when the agent went in.
    expect(listSessions.mock.calls[0][1]).toEqual(new Date("2026-08-25T10:00:00.000Z"));
    const state = loadSyncState(configDir);
    expect(state.incognito_agents).toEqual(["claude"]);
    expect(state.incognito_since).toBeUndefined();
    const at = NOW.toISOString();
    expect(state.sessions).toEqual({
      // Settled for what it holds now: it shipped before the switch went on.
      "cursor/shipped": entry({ task_id: "t1" }),
      // Its tail ran while incognito: none of it ships.
      "cursor/grown": agentIncognitoEntry(grown, at, VERSION),
      "cursor/unsettled": agentIncognitoEntry(unsettled, at, VERSION),
      "cursor/sub": agentIncognitoEntry(subagent, at, VERSION),
    });
  });

  it("keeps an answer another CLI version gave before the agent went in", () => {
    const passed = cursor("passed");
    const answer = entry({ outcome: "rejected", http_status: 413, cli_version: "0.0.1" });
    saveSyncState(
      {
        ...emptySyncState(),
        incognito_agents: ["cursor"],
        incognito_since: { cursor: "2026-08-25T10:00:00.000Z" },
        sessions: { "cursor/passed": answer },
      },
      configDir,
    );

    leaveIncognito(["cursor"], () => [passed], VERSION, NOW, configDir);

    // A newer CLI, or --retry-rejected, may still ship it.
    expect(loadSyncState(configDir).sessions["cursor/passed"]).toEqual(answer);
  });

  it("keeps what another command saved while it listed the sessions", () => {
    saveSyncState(
      {
        ...emptySyncState(),
        incognito_agents: ["cursor"],
        incognito_since: { cursor: "2026-08-25T10:00:00.000Z" },
      },
      configDir,
    );

    leaveIncognito(
      ["cursor"],
      () => {
        // `incognito on codex` and `transcripts disable` in another terminal, mid-scan.
        setAgentsIncognito(["codex"], true, configDir);
        setShipTranscripts(false, configDir);
        return [cursor("c1")];
      },
      VERSION,
      NOW,
      configDir,
    );

    const state = loadSyncState(configDir);
    expect(state.incognito_agents).toEqual(["codex"]);
    expect(state.ship_transcripts).toBe(false);
    expect(state.sessions["cursor/c1"]).toMatchObject({ by_agent: true });
  });

  it("goes back past the scan window to when the agent went in, or to 0.66's switch", () => {
    // In incognito for two months with nothing settling its sessions (shipping off, say).
    const old = cursor("old", { updated: "2026-07-01T00:00:00.000Z" });
    saveSyncState(
      {
        ...emptySyncState(),
        incognito_agents: ["claude", "cursor"],
        incognito_since: { cursor: "2026-06-25T00:00:00.000Z" },
      },
      configDir,
    );
    const listSessions = vi.fn((_state: SyncState, _since: Date) => [
      old,
      session({ id: "c1", updated: "2026-10-04T00:00:00Z" }),
    ]);

    leaveIncognito(["claude", "cursor"], listSessions, VERSION, NOW, configDir);

    expect(listSessions.mock.calls[0][1]).toEqual(new Date("2026-06-25T00:00:00.000Z"));
    // Claude Code went in with 0.66, which kept no time: nothing before that ran while it was.
    expect(Object.keys(loadSyncState(configDir).sessions)).toEqual(["cursor/old"]);
  });

  it("seals nothing of an agent that was not incognito", () => {
    saveSyncState({ ...emptySyncState(), incognito_agents: ["claude"] }, configDir);
    const listSessions = () => [cursor("c1")];

    leaveIncognito(["cursor"], listSessions, VERSION, NOW, configDir);

    const state = loadSyncState(configDir);
    expect(state.sessions).toEqual({});
    expect(state.incognito_agents).toEqual(["claude"]);
  });

  it("leaves the agent incognito when its sessions cannot be listed", () => {
    saveSyncState({ ...emptySyncState(), incognito_agents: ["cursor"] }, configDir);

    expect(() =>
      leaveIncognito(
        ["cursor"],
        () => {
          throw new Error("EACCES");
        },
        VERSION,
        NOW,
        configDir,
      ),
    ).toThrow("EACCES");

    expect(loadSyncState(configDir).incognito_agents).toEqual(["cursor"]);
  });

  it("drops the key once no agent is incognito", () => {
    saveSyncState({ ...emptySyncState(), incognito_agents: ["cursor"] }, configDir);
    leaveIncognito(["cursor"], () => [], VERSION, NOW, configDir);
    expect(readFileSync(syncStatePath(configDir), "utf-8")).not.toContain("incognito_agents");
  });
});

describe("sealAgentSession", () => {
  it("settles a listed agent's session as its switch does, once", () => {
    const s = session({ harness: "cursor", id: "c1", path: "/tmp/c1.jsonl" });
    saveSyncState({ ...emptySyncState(), incognito_agents: ["cursor"] }, configDir);

    sealAgentSession(s, VERSION, NOW, configDir);
    const sealed = loadSyncState(configDir).sessions["cursor/c1"];
    expect(sealed).toEqual(agentIncognitoEntry(s, NOW.toISOString(), VERSION));

    // Its later prompts, and another agent's sessions, change nothing.
    sealAgentSession({ ...s, updated: "2026-08-25T11:30:00Z" }, VERSION, NOW, configDir);
    sealAgentSession(session({ id: "claude-1" }), VERSION, NOW, configDir);
    expect(loadSyncState(configDir).sessions).toEqual({ "cursor/c1": sealed });
  });
});

describe("agentIncognitoEntry", () => {
  const s1 = (overrides: Partial<AgentSession> = {}) =>
    session({ harness: "cursor", id: "c1", path: "/tmp/c1.jsonl", ...overrides });

  it("settles the session for good, with no shipped prefix", () => {
    const at = NOW.toISOString();
    expect(agentIncognitoEntry(s1(), at, VERSION)).toEqual({
      updated: "2026-08-25T11:00:00Z",
      outcome: "incognito",
      at,
      cli_version: VERSION,
      by_agent: true,
      // Where the transcript is: the entry is kept while it is (pruneLedger).
      path: "/tmp/c1.jsonl",
    });
    expect(agentIncognitoEntry(s1({ parentId: "p" }), at, VERSION).parent).toBe("p");
  });

  it("round-trips through disk", () => {
    const sessions = { "cursor/c1": agentIncognitoEntry(s1(), NOW.toISOString(), VERSION) };
    saveSyncState({ ...emptySyncState(), sessions }, configDir);
    expect(loadSyncState(configDir).sessions).toEqual(sessions);
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
        ...emptySyncState(),
        sessions: { "claude/a": entry() },
        consecutive_failures: 2,
        total_shipped: 7,
      },
      configDir,
    );
    setSyncPaused(true, configDir);
    const loaded = loadSyncState(configDir);
    expect(loaded.sessions).toEqual({ "claude/a": entry() });
    expect(loaded.consecutive_failures).toBe(2);
    expect(loaded.total_shipped).toBe(7);
    expect(loaded.paused).toBe(true);
  });

  it("loadSyncState ignores non-boolean paused values", () => {
    writeRaw({ schema_version: 3, sessions: {}, consecutive_failures: 0, paused: "yes" });
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
    writeRaw({ schema_version: 3, sessions: {}, consecutive_failures: 0, ship_transcripts: "no" });
    expect(isShippingEnabled(loadSyncState(configDir))).toBe(true);
  });

  it("toggling preserves the rest of the state", () => {
    saveSyncState(
      { ...emptySyncState(), sessions: { "claude/a": entry() }, consecutive_failures: 2 },
      configDir,
    );
    setShipTranscripts(false, configDir);
    const loaded = loadSyncState(configDir);
    expect(loaded.sessions).toEqual({ "claude/a": entry() });
    expect(loaded.consecutive_failures).toBe(2);
  });
});
