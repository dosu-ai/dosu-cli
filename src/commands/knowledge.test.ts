import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mockQuery = vi.fn();
const mockMutate = vi.fn();

function createMockProxy(path: string[] = []): unknown {
  return new Proxy(() => {}, {
    get(_, prop: string) {
      if (prop === "query") return (input: unknown) => mockQuery(path.join("."), input);
      if (prop === "mutate") return (input: unknown) => mockMutate(path.join("."), input);
      return createMockProxy([...path, prop]);
    },
  });
}

vi.mock("../client/trpc", () => ({
  createTypedClient: vi.fn().mockImplementation(() => createMockProxy()),
}));

const mockLoadConfig = vi.fn();
vi.mock("../config/config", () => ({
  loadConfig: (...args: unknown[]) => mockLoadConfig(...args),
}));

const mockRunSync = vi.fn();
// Spread the real module so the batch-size constant the command reads
// (MINE_BATCH_LIMIT) keeps its production value.
vi.mock("../sync/sync", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../sync/sync")>()),
  runKnowledgeSync: (...args: unknown[]) => mockRunSync(...args),
}));

const mockSpawnDetached = vi.fn();
// Keep the real selfInvocation: the dev-mode hook command is built from it.
vi.mock("../sync/detach", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../sync/detach")>()),
  spawnDetachedSelf: (...args: unknown[]) => mockSpawnDetached(...args),
}));

const mockGetSyncStatus = vi.fn();
vi.mock("../sync/status", async (importOriginal) => ({
  // Keep the real formatTokenCount: only the status source is faked.
  ...(await importOriginal<typeof import("../sync/status")>()),
  getSyncStatus: (...args: unknown[]) => mockGetSyncStatus(...args),
}));

const mockListBacklog = vi.fn();
vi.mock("../sync/backlog", () => ({
  listSessionBacklog: (...args: unknown[]) => mockListBacklog(...args),
}));

const mockLoadSyncState = vi.fn();
vi.mock("../sync/watermark", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../sync/watermark")>()),
  loadSyncState: (...args: unknown[]) => mockLoadSyncState(...args),
}));

const mockEmitReport = vi.fn();
vi.mock("../report/generate", () => ({
  emitKnowledgeReport: (...args: unknown[]) => mockEmitReport(...args),
}));

const mockRunBackfill = vi.fn();
vi.mock("../report/backfill-run", () => ({
  runBackfill: (...args: unknown[]) => mockRunBackfill(...args),
}));

const mockRunLearner = vi.fn();
vi.mock("../learner/runner", () => ({
  runLearner: (...args: unknown[]) => mockRunLearner(...args),
}));

interface FakeAgent {
  id: string;
  name: string;
  installed: boolean;
  enabled: boolean;
  configPath: string;
  // `unknown` so tests can throw non-Error values through the reporting paths.
  enableError?: unknown;
  enabledError?: unknown;
  disableError?: unknown;
  note?: string;
}

let fakeAgents: FakeAgent[] = [];
const enableCalls: string[] = [];
const disableCalls: string[] = [];

function toHookAgent(agent: FakeAgent) {
  return {
    id: () => agent.id,
    name: () => agent.name,
    isInstalled: () => agent.installed,
    configPath: () => agent.configPath,
    isEnabled: () => {
      if (agent.enabledError) throw agent.enabledError;
      return agent.enabled;
    },
    enable: () => {
      if (agent.enableError) throw agent.enableError;
      enableCalls.push(agent.id);
    },
    disable: () => {
      if (agent.disableError) throw agent.disableError;
      disableCalls.push(agent.id);
    },
    ...(agent.note ? { enableNote: () => agent.note } : {}),
  };
}

vi.mock("../hooks/agents", () => ({
  allHookAgents: () => fakeAgents.map(toHookAgent),
  getHookAgent: (id: string) => {
    const found = fakeAgents.find((a) => a.id === id);
    return found ? toHookAgent(found) : undefined;
  },
}));

import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { type FlatTestConfig, makeTestConfig } from "../config/config.test-utils";
import { HookConfigError } from "../hooks/formats";
import { MINE_BATCH_LIMIT } from "../sync/sync";
import { consumeCommandFacets } from "../telemetry/telemetry";
import { knowledgeCommand } from "./knowledge";

let logSpy: ReturnType<typeof vi.spyOn>;
let errorSpy: ReturnType<typeof vi.spyOn>;
// biome-ignore lint/suspicious/noExplicitAny: process.exit mock type mismatch
let exitSpy: any;

const validFlatConfig: FlatTestConfig = {
  access_token: "t",
  refresh_token: "r",
  expires_at: 0,
  api_key: "sk_user_test",
  org_id: "org1",
  space_id: "sp1",
};
const makeValidConfig = (overrides: Partial<FlatTestConfig> = {}) =>
  makeTestConfig({ ...validFlatConfig, ...overrides });
const validConfig = makeValidConfig();

function allOutput(): string {
  return logSpy.mock.calls.map((c: unknown[]) => c.join(" ")).join("\n");
}

async function run(...args: string[]) {
  const cmd = knowledgeCommand();
  cmd.exitOverride();
  await cmd.parseAsync(["node", "test", ...args]);
}

beforeEach(() => {
  mockQuery.mockReset();
  mockLoadConfig.mockReset();
  mockRunSync.mockReset();
  mockSpawnDetached.mockReset();
  mockGetSyncStatus.mockReset();
  mockListBacklog.mockReset();
  mockLoadSyncState.mockReset();
  mockEmitReport.mockReset();
  mockEmitReport.mockResolvedValue("/tmp/dosu-knowledge-report.html");
  mockRunBackfill.mockReset();
  mockRunLearner.mockReset();
  fakeAgents = [];
  enableCalls.length = 0;
  disableCalls.length = 0;
  logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
  errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
  exitSpy = vi.spyOn(process, "exit").mockImplementation((() => {
    throw new Error("exit");
  }) as never);
  consumeCommandFacets(); // start each test with an empty analytics facet store
});

afterEach(() => {
  logSpy.mockRestore();
  errorSpy.mockRestore();
  exitSpy.mockRestore();
  process.exitCode = undefined;
});

describe("knowledge search", () => {
  it("orchestrates dataSource.list then search.getMentions with extracted IDs", async () => {
    mockLoadConfig.mockReturnValue(validConfig);
    mockQuery
      .mockResolvedValueOnce([
        { id: "ds1", name: "GH" },
        { id: "ds2", name: "Slack" },
      ])
      .mockResolvedValueOnce({ documents: [{ title: "Doc A", similarity: 0.95 }] });

    await run("search", "test query");

    expect(mockQuery).toHaveBeenCalledTimes(2);
    const [proc1, input1] = mockQuery.mock.calls[0];
    expect(proc1).toBe("dataSource.list");
    expect(input1).toEqual({ org_id: "org1", excluded_provider_slugs: [] });

    const [proc2, input2] = mockQuery.mock.calls[1];
    expect(proc2).toBe("search.getMentions");
    expect(input2.dataSourceIds).toEqual(["ds1", "ds2"]);
    expect(input2.query).toBe("test query");
  });

  it("outputs valid JSON with --json flag", async () => {
    mockLoadConfig.mockReturnValue(validConfig);
    mockQuery
      .mockResolvedValueOnce([{ id: "ds1" }])
      .mockResolvedValueOnce({ documents: [{ title: "Result", similarity: 0.8 }] });

    await run("search", "--json", "query");

    const output = JSON.parse(allOutput());
    expect(output.documents).toHaveLength(1);
    expect(output.documents[0]).toMatchObject({ title: "Result", similarity: 0.8 });
  });

  it("prints message when no data sources connected", async () => {
    mockLoadConfig.mockReturnValue(validConfig);
    mockQuery.mockResolvedValueOnce([]);

    await run("search", "query");

    expect(allOutput()).toContain("No data sources connected");
  });

  it("prints message when search returns empty", async () => {
    mockLoadConfig.mockReturnValue(validConfig);
    mockQuery.mockResolvedValueOnce([{ id: "ds1" }]).mockResolvedValueOnce({ documents: [] });

    await run("search", "query");

    expect(allOutput()).toContain("No results found");
  });

  it("respects --limit and shows remaining count", async () => {
    mockLoadConfig.mockReturnValue(validConfig);
    const results = Array.from({ length: 5 }, (_, i) => ({
      title: `Doc ${i}`,
      similarity: 0.9 - i * 0.1,
    }));
    mockQuery.mockResolvedValueOnce([{ id: "ds1" }]).mockResolvedValueOnce({ documents: results });

    await run("search", "--limit", "3", "query");

    const output = allOutput();
    expect(output).toContain("2 more results not shown");
  });

  it("rejects an invalid limit before calling tRPC", async () => {
    mockLoadConfig.mockReturnValue(validConfig);
    await expect(run("search", "--limit", "0", "query")).rejects.toThrow();
    expect(mockQuery).not.toHaveBeenCalled();
  });

  it("falls back to placeholders for untitled or untyped results", async () => {
    mockLoadConfig.mockReturnValue(validConfig);
    mockQuery.mockResolvedValueOnce([{ id: "ds1" }, { id: null }]).mockResolvedValueOnce({
      documents: [
        { title: null, entity_type: null },
        { title: "Typed", entity_type: "issue" },
      ],
    });

    await run("search", "query");

    // Null data source IDs are dropped before the search call.
    expect(mockQuery.mock.calls[1][1].dataSourceIds).toEqual(["ds1"]);
    const output = allOutput();
    expect(output).toContain("(untitled)");
    expect(output).toContain("issue");
    expect(output).not.toContain("more results not shown");
  });

  it("treats a missing documents field as no results", async () => {
    mockLoadConfig.mockReturnValue(validConfig);
    mockQuery.mockResolvedValueOnce([{ id: "ds1" }]).mockResolvedValueOnce({});

    await run("search", "query");

    expect(allOutput()).toContain("No results found");
  });
});

describe("knowledge list", () => {
  it("calls knowledgeStore.getBySpaceId with space_id", async () => {
    mockLoadConfig.mockReturnValue(validConfig);
    mockQuery.mockResolvedValueOnce({ id: "ks1", space_id: "sp1" });

    await run("list");

    expect(mockQuery).toHaveBeenCalledWith("knowledgeStore.getBySpaceId", { space_id: "sp1" });
  });

  it("outputs valid JSON with --json flag", async () => {
    mockLoadConfig.mockReturnValue(validConfig);
    mockQuery.mockResolvedValueOnce({ id: "ks1", space_id: "sp1" });

    await run("list", "--json");

    expect(JSON.parse(allOutput())).toMatchObject({ id: "ks1", space_id: "sp1" });
  });

  it("prints message when store is null", async () => {
    mockLoadConfig.mockReturnValue(validConfig);
    mockQuery.mockResolvedValueOnce(null);

    await run("list");

    expect(allOutput()).toContain("No knowledge store found");
  });
});

describe("requireConfig", () => {
  it("exits when access_token is missing", async () => {
    mockLoadConfig.mockReturnValue(makeValidConfig({ access_token: "" }));
    await expect(run("search", "q")).rejects.toThrow("exit");
    expect(exitSpy).toHaveBeenCalledWith(1);
  });

  it("exits when org_id is missing", async () => {
    mockLoadConfig.mockReturnValue(makeValidConfig({ org_id: undefined }));
    await expect(run("search", "q")).rejects.toThrow("exit");
  });

  it("exits when space_id is missing", async () => {
    mockLoadConfig.mockReturnValue(makeValidConfig({ space_id: undefined }));
    await expect(run("search", "q")).rejects.toThrow("exit");
  });
});

describe("knowledge sessions", () => {
  const queuedSession = {
    id: "3c2c12ad-b111-4444-8888-abcdefabcdef",
    harness: "cursor",
    path: "/tmp/a.jsonl",
    project: "Users-james-Documents-dosu-global-dosu-cli",
    updated: "2026-09-04T18:22:00.000Z",
  };
  const openSession = {
    id: "086d98d5-3333-4444-8888-abcdefabcdef",
    harness: "claude",
    path: "/tmp/b.jsonl",
    updated: "2026-09-04T19:59:00.000Z",
  };
  const syncState = {
    schema_version: 1,
    watermark: "2026-09-02T23:00:00.000Z",
    consecutive_failures: 0,
    mined_sessions: [
      {
        at: "2026-09-02T23:00:00.000Z",
        session: "cursor/1d4b4ea0-e555-4444-8888-abcdefabcdef",
        project: "dosu-cli",
      },
    ],
  };

  it("prints every section with full, untruncated projects and ids", async () => {
    mockListBacklog.mockReturnValue({ queued: [queuedSession], open: [openSession] });
    mockLoadSyncState.mockReturnValue(syncState);

    await run("sessions");

    const out = allOutput();
    expect(out).toContain("Queued (1)");
    expect(out).toContain("Open (1)");
    expect(out).toContain("Studied (1)");
    // The whole point of the command: nothing is clipped.
    expect(out).toContain(queuedSession.id);
    expect(out).toContain(queuedSession.project);
    expect(out).toContain(openSession.id);
    expect(out).toContain("1d4b4ea0-e555-4444-8888-abcdefabcdef");
    expect(out).not.toContain("\u2026");
    // Studied history's "harness/id" splits back into columns.
    expect(out).not.toContain("cursor/1d4b4ea0");
  });

  it("shows per-section empty messages", async () => {
    mockListBacklog.mockReturnValue({ queued: [], open: [] });
    mockLoadSyncState.mockReturnValue({ ...syncState, mined_sessions: [] });

    await run("sessions");

    const out = allOutput();
    expect(out).toContain("Queue empty.");
    expect(out).toContain("No open sessions.");
    expect(out).toContain("No studied sessions recorded yet.");
  });

  it("--queued lists only the queue and never reads the sync state", async () => {
    mockListBacklog.mockReturnValue({ queued: [queuedSession], open: [openSession] });

    await run("sessions", "--queued");

    const out = allOutput();
    expect(out).toContain("Queued (1)");
    expect(out).not.toContain("Open (");
    expect(out).not.toContain("Studied (");
    expect(mockLoadSyncState).not.toHaveBeenCalled();
  });

  it("--studied alone skips the session scan", async () => {
    mockLoadSyncState.mockReturnValue(syncState);

    await run("sessions", "--studied");

    expect(mockListBacklog).not.toHaveBeenCalled();
    expect(allOutput()).toContain("Studied (1)");
  });

  it("--json emits only the requested sections", async () => {
    mockListBacklog.mockReturnValue({ queued: [queuedSession], open: [openSession] });

    await run("sessions", "--queued", "--open", "--json");

    const parsed = JSON.parse(allOutput());
    expect(parsed).toEqual({ queued: [queuedSession], open: [openSession] });
    expect(parsed.studied).toBeUndefined();
  });

  it("--studied --json emits only the studied history", async () => {
    mockLoadSyncState.mockReturnValue(syncState);

    await run("sessions", "--studied", "--json");

    expect(JSON.parse(allOutput())).toEqual({ studied: syncState.mined_sessions });
    expect(mockListBacklog).not.toHaveBeenCalled();
  });

  it("treats a sync state without mined_sessions as empty history", async () => {
    mockListBacklog.mockReturnValue({ queued: [], open: [] });
    mockLoadSyncState.mockReturnValue({ schema_version: 1, watermark: null });

    await run("sessions");

    expect(allOutput()).toContain("Studied (0)");
  });

  it("keeps legacy studied records that lack a harness prefix or project", async () => {
    mockLoadSyncState.mockReturnValue({
      ...syncState,
      mined_sessions: [{ at: "2026-09-01T00:00:00.000Z", session: "bare-session-id" }],
    });

    await run("sessions", "--studied");

    const out = allOutput();
    expect(out).toContain("Studied (1)");
    expect(out).toContain("bare-session-id");
    // No "/" means no harness column and no project: both render as "-".
    const row = logSpy.mock.calls
      .map((c: unknown[]) => c.join(" "))
      .find((line: string) => line.includes("bare-session-id"));
    expect(row).toMatch(/^-\s+2026-09-01T00:00:00\.000Z\s+-\s+bare-session-id/);
  });
});

describe("knowledge sync", () => {
  beforeEach(() => {
    // Authenticated cloud-mode install: sync should build a learner.
    mockLoadConfig.mockReturnValue(makeValidConfig({ deployment_id: "dep1" }));
  });

  function syncDeps(call = 0): { mine?: unknown } {
    return mockRunSync.mock.calls[call][0].deps;
  }

  it("prints the backlog after a successful run", async () => {
    mockRunSync.mockResolvedValue({ status: "backlog", readySessions: 3, inFlightSessions: 1 });

    await run("sync");

    expect(mockRunSync.mock.calls[0][0].quiet).toBeUndefined();
    expect(typeof syncDeps().mine).toBe("function");
    expect(allOutput()).toContain("3 new sessions ready to study");
  });

  it("does not build a learner when the install has no API key", async () => {
    mockLoadConfig.mockReturnValue(makeValidConfig({ api_key: undefined }));
    mockRunSync.mockResolvedValue({ status: "backlog", readySessions: 1, inFlightSessions: 0 });

    await run("sync");

    expect(syncDeps().mine).toBeUndefined();
  });

  it("does not build a learner in OSS mode", async () => {
    mockLoadConfig.mockReturnValue(makeValidConfig({ deployment_id: "dep1", mode: "oss" }));
    mockRunSync.mockResolvedValue({ status: "backlog", readySessions: 1, inFlightSessions: 0 });

    await run("sync");

    expect(syncDeps().mine).toBeUndefined();
  });

  it("the learner forwards the install's credentials and a manual trigger", async () => {
    mockRunSync.mockResolvedValue({ status: "nothing-new", readySessions: 0, inFlightSessions: 0 });
    const result = { outcome: "completed", notesWritten: 2, turns: 3 };
    mockRunLearner.mockResolvedValue(result);

    await run("sync");

    const mine = syncDeps().mine as (sessions: unknown[]) => Promise<unknown>;
    const sessions = [{ id: "s1", harness: "cursor", path: "/tmp/s1.jsonl", updated: "now" }];
    await expect(mine(sessions)).resolves.toEqual(result);
    expect(mockRunLearner).toHaveBeenCalledWith({
      sessions,
      apiKey: "sk_user_test",
      deploymentID: "dep1",
      trigger: "manual",
    });
  });

  it("--quiet builds the learner with a hook trigger", async () => {
    mockRunSync.mockResolvedValue({ status: "nothing-new", readySessions: 0, inFlightSessions: 0 });
    mockRunLearner.mockResolvedValue({ outcome: "completed", notesWritten: 0, turns: 0 });

    await run("sync", "--quiet");

    const mine = syncDeps().mine as (sessions: unknown[]) => Promise<unknown>;
    await mine([]);
    expect(mockRunLearner).toHaveBeenCalledWith(expect.objectContaining({ trigger: "hook" }));
  });

  it("reports a studied run with the remaining backlog", async () => {
    mockRunSync.mockResolvedValue({
      status: "studied",
      readySessions: 8,
      inFlightSessions: 0,
      sessions: [],
      studiedSessions: 5,
      learner: { outcome: "completed", notesWritten: 3, turns: 12 },
    });

    await run("sync");

    const output = allOutput();
    expect(output).toContain("Studied 5 sessions, 3 suggested pages created");
    expect(output).toContain("3 more in the backlog");
  });

  it("renders the gateway's refusal message on skipped-gateway", async () => {
    mockRunSync.mockResolvedValue({
      status: "skipped-gateway",
      readySessions: 2,
      inFlightSessions: 0,
      sessions: [],
      studiedSessions: 0,
      learner: { outcome: "consent_off", notesWritten: 0, turns: 0, message: "org opt-in is off" },
    });

    await run("sync");

    expect(allOutput()).toContain("org opt-in is off");
    expect(process.exitCode).toBeUndefined();
  });

  it("mine-failed prints the learner message and sets the exit code", async () => {
    mockRunSync.mockResolvedValue({
      status: "mine-failed",
      readySessions: 2,
      inFlightSessions: 0,
      sessions: [],
      studiedSessions: 0,
      learner: { outcome: "error", notesWritten: 0, turns: 4, message: "run exploded" },
    });

    await run("sync");

    expect(errorSpy.mock.calls.join(" ")).toContain("run exploded");
    expect(process.exitCode).toBe(1);
  });

  it("mentions the concurrent run on skipped-lock", async () => {
    mockRunSync.mockResolvedValue({
      status: "skipped-lock",
      readySessions: 2,
      inFlightSessions: 0,
      sessions: [],
    });

    await run("sync");

    expect(allOutput()).toContain("already in progress");
  });

  it("prints nothing-new when the gate is empty", async () => {
    mockRunSync.mockResolvedValue({ status: "nothing-new", readySessions: 0, inFlightSessions: 0 });

    await run("sync");

    expect(allOutput()).toContain("No new completed sessions");
  });

  it("nothing-new mentions a single session still in progress", async () => {
    mockRunSync.mockResolvedValue({ status: "nothing-new", readySessions: 0, inFlightSessions: 1 });

    await run("sync");

    expect(allOutput()).toContain("1 session still in progress.");
  });

  it("nothing-new pluralizes several sessions still in progress", async () => {
    mockRunSync.mockResolvedValue({ status: "nothing-new", readySessions: 0, inFlightSessions: 3 });

    await run("sync");

    expect(allOutput()).toContain("3 sessions still in progress.");
  });

  it("backlog uses the singular for one ready session and omits the in-flight note", async () => {
    mockRunSync.mockResolvedValue({ status: "backlog", readySessions: 1, inFlightSessions: 0 });

    await run("sync");

    const output = allOutput();
    expect(output).toContain("1 new session ready to study.");
    expect(output).not.toContain("still in progress");
  });

  it("studied uses singulars and tolerates a missing learner summary", async () => {
    mockRunSync.mockResolvedValue({
      status: "studied",
      readySessions: 1,
      inFlightSessions: 0,
      sessions: [],
      studiedSessions: 1,
    });

    await run("sync");

    const output = allOutput();
    expect(output).toContain("Studied 1 session, 0 suggested pages created.");
    expect(output).not.toContain("more in the backlog");
  });

  it("studied treats a missing studiedSessions count as zero when sizing the backlog", async () => {
    mockRunSync.mockResolvedValue({
      status: "studied",
      readySessions: 4,
      inFlightSessions: 0,
      sessions: [],
      learner: { outcome: "completed", notesWritten: 1, turns: 2 },
    });

    await run("sync");

    const output = allOutput();
    expect(output).toContain("1 suggested page created.");
    expect(output).toContain("4 more in the backlog");
  });

  it("skipped-gateway falls back to a generic message without a learner reason", async () => {
    mockRunSync.mockResolvedValue({
      status: "skipped-gateway",
      readySessions: 2,
      inFlightSessions: 0,
      sessions: [],
      studiedSessions: 0,
    });

    await run("sync");

    expect(allOutput()).toContain("Studying unavailable right now.");
  });

  it("mine-failed falls back to a generic message without a learner reason", async () => {
    mockRunSync.mockResolvedValue({
      status: "mine-failed",
      readySessions: 2,
      inFlightSessions: 0,
      sessions: [],
      studiedSessions: 0,
    });

    await run("sync");

    expect(errorSpy.mock.calls.join(" ")).toContain("Study run failed.");
    expect(process.exitCode).toBe(1);
  });

  it("explains a skipped-paused run", async () => {
    mockRunSync.mockResolvedValue({
      status: "skipped-paused",
      readySessions: 0,
      inFlightSessions: 0,
    });

    await run("sync");

    expect(allOutput()).toContain("studying is paused");
    expect(process.exitCode).toBeUndefined();
  });

  it("reports errors and sets the exit code", async () => {
    mockRunSync.mockResolvedValue({
      status: "error",
      readySessions: 0,
      inFlightSessions: 0,
      error: "scan exploded",
    });

    await run("sync");

    expect(errorSpy.mock.calls.join(" ")).toContain("scan exploded");
    expect(process.exitCode).toBe(1);
  });

  it("mentions the backoff when a quiet failure is being waited out", async () => {
    mockRunSync.mockResolvedValue({
      status: "skipped-backoff",
      readySessions: 0,
      inFlightSessions: 0,
    });

    await run("sync");

    expect(allOutput()).toContain("backoff");
  });

  it("--quiet prints nothing and exits 0 even on error", async () => {
    mockRunSync.mockResolvedValue({
      status: "error",
      readySessions: 0,
      inFlightSessions: 0,
      error: "boom",
    });

    await run("sync", "--quiet");

    expect(logSpy).not.toHaveBeenCalled();
    expect(errorSpy).not.toHaveBeenCalled();
    expect(process.exitCode).toBeUndefined();
  });

  it("--json emits the outcome as JSON", async () => {
    mockRunSync.mockResolvedValue({ status: "backlog", readySessions: 2, inFlightSessions: 0 });

    await run("sync", "--json");

    expect(JSON.parse(allOutput())).toMatchObject({ status: "backlog", readySessions: 2 });
  });

  it("--json still sets the exit code on a sync error", async () => {
    mockRunSync.mockResolvedValue({
      status: "error",
      readySessions: 0,
      inFlightSessions: 0,
      error: "scan exploded",
    });

    await run("sync", "--json");

    expect(JSON.parse(allOutput())).toMatchObject({ status: "error", error: "scan exploded" });
    expect(errorSpy).not.toHaveBeenCalled();
    expect(process.exitCode).toBe(1);
  });

  it("--json --report keeps the outcome on stdout when the report fails", async () => {
    mockRunSync.mockResolvedValue({ status: "nothing-new", readySessions: 0, inFlightSessions: 0 });
    mockEmitReport.mockRejectedValue(new Error("no notes to render"));

    await run("sync", "--json", "--report");

    expect(JSON.parse(allOutput())).toEqual({
      status: "nothing-new",
      readySessions: 0,
      inFlightSessions: 0,
      report_error: "no notes to render",
    });
    // Studying succeeded; a report failure alone does not fail the command.
    expect(process.exitCode).toBeUndefined();
  });

  it("--json --report stringifies non-Error report failures", async () => {
    mockRunSync.mockResolvedValue({ status: "nothing-new", readySessions: 0, inFlightSessions: 0 });
    mockEmitReport.mockRejectedValue("disk full");

    await run("sync", "--json", "--report");

    expect(JSON.parse(allOutput())).toMatchObject({ report_error: "disk full" });
  });

  it("--report prints the failure and sets the exit code after a foreground sync", async () => {
    mockRunSync.mockResolvedValue({ status: "nothing-new", readySessions: 0, inFlightSessions: 0 });
    mockEmitReport.mockRejectedValue(new Error("browser missing"));

    await run("sync", "--report");

    expect(allOutput()).toContain("No new completed sessions");
    expect(allOutput()).not.toContain("Wrote ");
    expect(errorSpy.mock.calls.join(" ")).toContain("browser missing");
    expect(process.exitCode).toBe(1);
  });

  it("--report stringifies non-Error failures", async () => {
    mockRunSync.mockResolvedValue({ status: "nothing-new", readySessions: 0, inFlightSessions: 0 });
    mockEmitReport.mockRejectedValue("disk full");

    await run("sync", "--report");

    expect(errorSpy.mock.calls.join(" ")).toContain("disk full");
    expect(process.exitCode).toBe(1);
  });

  it("knowledge report --json prints the path and never opens a browser", async () => {
    await run("report", "--json", "--out", "/tmp/custom-report.html");

    expect(mockEmitReport).toHaveBeenCalledWith({ out: "/tmp/custom-report.html", open: false });
    expect(JSON.parse(allOutput())).toEqual({ report: "/tmp/dosu-knowledge-report.html" });
  });

  it("knowledge report opens the browser by default", async () => {
    await run("report");

    expect(mockEmitReport).toHaveBeenCalledWith({ out: undefined, open: true });
  });

  it("--report writes and opens the harvest HTML after a foreground sync", async () => {
    mockLoadConfig.mockReturnValue(makeValidConfig({ deployment_id: "dep1" }));
    mockRunSync.mockResolvedValue({
      status: "studied",
      readySessions: 2,
      inFlightSessions: 0,
      sessions: [],
      studiedSessions: 2,
      learner: { outcome: "completed", notesWritten: 1, turns: 4 },
    });

    await run("sync", "--report", "--out", "/tmp/custom-report.html");

    expect(mockEmitReport).toHaveBeenCalledWith({
      out: "/tmp/custom-report.html",
      open: true,
    });
    expect(allOutput()).toContain("Wrote /tmp/dosu-knowledge-report.html");
  });

  it("knowledge report writes the HTML without running sync", async () => {
    mockLoadConfig.mockReturnValue(makeValidConfig({ deployment_id: "dep1" }));
    await run("report", "--no-open");
    expect(mockRunSync).not.toHaveBeenCalled();
    expect(mockEmitReport).toHaveBeenCalledWith({
      out: undefined,
      open: false,
    });
    expect(allOutput()).toContain("Wrote /tmp/dosu-knowledge-report.html");
  });

  it("--quiet --report stays silent and does not write HTML", async () => {
    mockRunSync.mockResolvedValue({ status: "studied", readySessions: 0, inFlightSessions: 0 });
    await run("sync", "--quiet", "--report");
    expect(mockEmitReport).not.toHaveBeenCalled();
    expect(logSpy).not.toHaveBeenCalled();
  });

  it("--json --report includes the HTML path and does not open a browser", async () => {
    mockRunSync.mockResolvedValue({ status: "nothing-new", readySessions: 0, inFlightSessions: 0 });
    await run("sync", "--json", "--report", "--out", "/tmp/custom-report.html");
    expect(mockEmitReport).toHaveBeenCalledWith({
      out: "/tmp/custom-report.html",
      open: false,
    });
    expect(JSON.parse(allOutput())).toMatchObject({
      status: "nothing-new",
      report: "/tmp/dosu-knowledge-report.html",
    });
  });

  it("--detach re-spawns and never runs the pipeline inline", async () => {
    await run("sync", "--quiet", "--detach");

    expect(mockSpawnDetached).toHaveBeenCalledWith(["knowledge", "sync", "--quiet"]);
    expect(mockRunSync).not.toHaveBeenCalled();
  });

  it("--detach forwards --bootstrap to the re-spawned run", async () => {
    await run("sync", "--quiet", "--detach", "--bootstrap");

    expect(mockSpawnDetached).toHaveBeenCalledWith(["knowledge", "sync", "--quiet", "--bootstrap"]);
  });

  it("--detach without --quiet omits the flag", async () => {
    await run("sync", "--detach");

    expect(mockSpawnDetached).toHaveBeenCalledWith(["knowledge", "sync"]);
    expect(mockRunSync).not.toHaveBeenCalled();
  });

  it("--detach forwards --report and --out to the re-spawned run", async () => {
    await run("sync", "--detach", "--report", "--out", "/tmp/custom-report.html");

    expect(mockSpawnDetached).toHaveBeenCalledWith([
      "knowledge",
      "sync",
      "--report",
      "--out",
      "/tmp/custom-report.html",
    ]);
    expect(mockEmitReport).not.toHaveBeenCalled();
  });

  function studiedOutcome(remaining: number) {
    return {
      status: "studied",
      readySessions: remaining,
      inFlightSessions: 0,
      sessions: [],
      studiedSessions: Math.min(remaining, 5),
      learner: { outcome: "completed", notesWritten: 2, turns: 10 },
    };
  }

  describe("analytics facets", () => {
    it("tags a hook-triggered study run with its status and bucketable counts", async () => {
      mockRunSync.mockResolvedValue({
        status: "studied",
        readySessions: 8,
        inFlightSessions: 0,
        sessions: [],
        studiedSessions: 5,
        learner: { outcome: "completed", notesWritten: 3, turns: 12 },
      });

      await run("sync", "--quiet");

      expect(consumeCommandFacets()).toEqual({
        sync_trigger: "hook",
        sync_status: "studied",
        sessions_studied: 5,
        notes_written: 3,
        learner_outcome: "completed",
      });
    });

    it("tags a failed study run with the learner's coarse diagnostics, never its message", async () => {
      mockRunSync.mockResolvedValue({
        status: "mine-failed",
        readySessions: 2,
        inFlightSessions: 0,
        sessions: [],
        studiedSessions: 0,
        learner: {
          outcome: "gateway_rejected",
          notesWritten: 0,
          turns: 1,
          message: "LLM gateway rejected the study run: secret detail",
          gatewayReason: "system_role_unsupported",
          claudeCodeSource: "system",
          claudeCodeVersion: "2.1.280",
          model: "claude-haiku-4-5",
        },
        error: "LLM gateway rejected the study run: secret detail",
      });

      await run("sync", "--quiet");

      const facets = consumeCommandFacets();
      expect(facets).toEqual({
        sync_trigger: "hook",
        sync_status: "mine-failed",
        sessions_studied: 0,
        notes_written: 0,
        learner_outcome: "gateway_rejected",
        gateway_reason: "system_role_unsupported",
        claude_code_source: "system",
        claude_code_version: "2.1.280",
        learner_model: "claude-haiku-4-5",
      });
      expect(JSON.stringify(facets)).not.toContain("secret");
    });

    it("tags a manual run that only reported the backlog", async () => {
      mockRunSync.mockResolvedValue({ status: "backlog", readySessions: 3, inFlightSessions: 1 });

      await run("sync");

      expect(consumeCommandFacets()).toEqual({
        sync_trigger: "manual",
        sync_status: "backlog",
        sessions_studied: 0,
        notes_written: 0,
      });
    });

    it("sums sessions and notes across bootstrap rounds and keeps the final status", async () => {
      mockRunSync
        .mockResolvedValueOnce(studiedOutcome(8))
        .mockResolvedValueOnce(studiedOutcome(3))
        .mockResolvedValue({ status: "nothing-new", readySessions: 0, inFlightSessions: 0 });

      await run("sync", "--bootstrap");

      expect(consumeCommandFacets()).toEqual({
        sync_trigger: "bootstrap",
        sync_status: "nothing-new",
        sessions_studied: 8,
        notes_written: 4,
      });
    });

    it("tags the --detach parent so it is never counted as a pipeline run", async () => {
      mockSpawnDetached.mockReturnValue(true);

      await run("sync", "--quiet", "--detach");

      expect(consumeCommandFacets()).toEqual({ sync_trigger: "hook", sync_status: "detached" });
    });

    it("reports a failed detached spawn", async () => {
      mockSpawnDetached.mockReturnValue(false);

      await run("sync", "--detach", "--bootstrap");

      expect(consumeCommandFacets()).toEqual({
        sync_trigger: "bootstrap",
        sync_status: "detach-failed",
      });
    });

    it("tags --status as a read-only invocation", async () => {
      mockGetSyncStatus.mockReturnValue({
        running: false,
        state: { schema_version: 1, watermark: null, consecutive_failures: 0 },
        recentActivity: [],
      });

      await run("sync", "--status");

      expect(consumeCommandFacets()).toEqual({
        sync_trigger: "manual",
        sync_status: "status-only",
      });
    });
  });

  it("--bootstrap passes the bootstrap scope on every round", async () => {
    mockRunSync
      .mockResolvedValueOnce(studiedOutcome(8))
      .mockResolvedValueOnce(studiedOutcome(3))
      .mockResolvedValue({ status: "nothing-new", readySessions: 0, inFlightSessions: 0 });

    await run("sync", "--bootstrap");

    expect(mockRunSync).toHaveBeenCalledTimes(3);
    for (const call of mockRunSync.mock.calls) {
      expect(call[0].bootstrap).toBe(true);
    }
  });

  it("--bootstrap drains the backlog and reports each round", async () => {
    mockRunSync
      .mockResolvedValueOnce(studiedOutcome(8))
      .mockResolvedValueOnce(studiedOutcome(3))
      .mockResolvedValue({ status: "nothing-new", readySessions: 0, inFlightSessions: 0 });

    await run("sync", "--bootstrap");

    const output = allOutput();
    expect(output).toContain("Studied 5 sessions");
    expect(output).toContain("Studied 3 sessions");
    expect(output).toContain("No new completed sessions");
  });

  it("--bootstrap stops the drain on a failed round", async () => {
    mockRunSync.mockResolvedValueOnce(studiedOutcome(8)).mockResolvedValue({
      status: "mine-failed",
      readySessions: 3,
      inFlightSessions: 0,
      sessions: [],
      studiedSessions: 0,
      learner: { outcome: "error", notesWritten: 0, turns: 1, message: "run exploded" },
    });

    await run("sync", "--bootstrap");

    expect(mockRunSync).toHaveBeenCalledTimes(2);
    expect(errorSpy.mock.calls.join(" ")).toContain("run exploded");
    expect(process.exitCode).toBe(1);
  });

  it("--bootstrap --quiet drains silently", async () => {
    mockRunSync
      .mockResolvedValueOnce(studiedOutcome(8))
      .mockResolvedValue({ status: "nothing-new", readySessions: 0, inFlightSessions: 0 });

    await run("sync", "--quiet", "--bootstrap");

    expect(mockRunSync).toHaveBeenCalledTimes(2);
    expect(logSpy).not.toHaveBeenCalled();
  });

  it("--bootstrap is capped even if studying always reports more", async () => {
    // Every round claims two batches' worth of sessions are still ready; the
    // cap comes from the first round's backlog: ceil(ready/batch)+2 rounds.
    const ready = MINE_BATCH_LIMIT * 2;
    mockRunSync.mockResolvedValue(studiedOutcome(ready));

    await run("sync", "--bootstrap");

    expect(mockRunSync).toHaveBeenCalledTimes(Math.ceil(ready / MINE_BATCH_LIMIT) + 2);
  });

  it("--bootstrap without a learner stays single-shot", async () => {
    mockLoadConfig.mockReturnValue(makeValidConfig({ api_key: undefined }));
    mockRunSync.mockResolvedValue({
      status: "backlog",
      readySessions: 4,
      inFlightSessions: 0,
      sessions: [],
    });

    await run("sync", "--bootstrap");

    expect(mockRunSync).toHaveBeenCalledTimes(1);
  });
});

describe("knowledge sync --status", () => {
  const baseState = { schema_version: 1, watermark: null, consecutive_failures: 0 };

  beforeEach(() => {
    mockLoadConfig.mockReturnValue(makeValidConfig({ deployment_id: "dep1" }));
  });

  it("surfaces a user-paused pipeline with the resume paths", async () => {
    mockGetSyncStatus.mockReturnValue({
      running: false,
      state: { ...baseState, paused: true },
      recentActivity: [],
    });

    await run("sync", "--status");

    const out = allOutput();
    expect(out).toContain("Studying paused: stopped by you");
    expect(out).toContain("'dosu knowledge sync'");
  });

  it("reports a running sync without scanning or studying", async () => {
    mockGetSyncStatus.mockReturnValue({
      running: true,
      pid: 4242,
      startedAt: new Date(Date.now() - 3 * 60_000).toISOString(),
      state: { ...baseState, watermark: new Date(Date.now() - 2 * 86_400_000).toISOString() },
      recentActivity: ["[t] [sync] studied 5 sessions, 4 suggested pages"],
    });

    await run("sync", "--status");

    const output = allOutput();
    expect(output).toContain("Sync running \u00B7 pid 4242");
    expect(output).toContain("3m ago");
    expect(output).toContain("Studied through:");
    expect(output).toContain("2d ago");
    expect(output).toContain("studied 5 sessions, 4 suggested pages");
    expect(output).toContain("logs --follow");
    expect(mockRunSync).not.toHaveBeenCalled();
  });

  it("reports the all-time notes and token analytics when present", async () => {
    mockGetSyncStatus.mockReturnValue({
      running: false,
      state: {
        ...baseState,
        watermark: "2026-08-25T11:00:00Z",
        total_mined: 120,
        total_notes: 47,
        total_learning_tokens: 312_000,
      },
      recentActivity: [],
    });

    await run("sync", "--status");

    expect(allOutput()).toContain(
      "Suggested pages: 47 (from 120 sessions, ~312k tokens distilled)",
    );
  });

  it("reports idle with nothing studied yet", async () => {
    mockGetSyncStatus.mockReturnValue({ running: false, state: baseState, recentActivity: [] });

    await run("sync", "--status");

    const output = allOutput();
    expect(output).toContain("No sync running");
    expect(output).toContain("nothing studied yet");
    expect(output).not.toContain("Suggested pages");
    expect(output).not.toContain("Recent activity");
  });

  it("flags a stale lock left by a dead run", async () => {
    mockGetSyncStatus.mockReturnValue({
      running: false,
      staleLock: true,
      pid: 99,
      startedAt: new Date().toISOString(),
      state: baseState,
      recentActivity: [],
    });

    await run("sync", "--status");

    expect(allOutput()).toContain("Stale lock from pid 99");
  });

  it("shows the last attempt and the backoff window", async () => {
    const lastAttempt = new Date(Date.now() - 90 * 60_000).toISOString();
    mockGetSyncStatus.mockReturnValue({
      running: false,
      state: { ...baseState, last_attempt_at: lastAttempt, consecutive_failures: 2 },
      backoffUntil: "2026-09-02T23:00:00.000Z",
      recentActivity: [],
    });

    await run("sync", "--status");

    const output = allOutput();
    expect(output).toContain("Last attempt:");
    expect(output).toContain("1h 30m ago");
    expect(output).toContain("Backing off after 2 failures");
    expect(output).toContain("2026-09-02T23:00:00.000Z");
  });

  it("shows a gateway rejection's reason next to its backoff window", async () => {
    const at = new Date(Date.now() - 5 * 60_000).toISOString();
    mockGetSyncStatus.mockReturnValue({
      running: false,
      state: {
        ...baseState,
        last_attempt_at: at,
        consecutive_failures: 1,
        last_refusal: {
          at,
          outcome: "gateway_rejected",
          message: "LLM gateway rejected the study run: max_tokens: 128000 > 64000",
        },
      },
      backoffUntil: "2026-09-02T23:00:00.000Z",
      recentActivity: [],
    });

    await run("sync", "--status");

    const output = allOutput();
    expect(output).toContain("Backing off after 1 failure;");
    expect(output).toContain(
      "Studying paused: LLM gateway rejected the study run: max_tokens: 128000 > 64000 (5m ago)",
    );
  });

  it("explains a persisted gateway refusal", async () => {
    mockGetSyncStatus.mockReturnValue({
      running: false,
      state: {
        ...baseState,
        last_refusal: {
          at: new Date(Date.now() - 10 * 60_000).toISOString(),
          outcome: "credit_limit",
          message: "Your org has used its Dosu credits for this billing period.",
        },
      },
      recentActivity: [],
    });

    await run("sync", "--status");

    const output = allOutput();
    expect(output).toContain("Studying paused: Your org has used its Dosu credits");
    expect(output).toContain("10m ago");
  });

  it("renders very recent timestamps as 'just now'", async () => {
    mockGetSyncStatus.mockReturnValue({
      running: true,
      pid: 7,
      startedAt: new Date().toISOString(),
      state: baseState,
      recentActivity: [],
    });

    await run("sync", "--status");

    expect(allOutput()).toContain("started just now");
  });

  it("--json emits the raw status object", async () => {
    mockGetSyncStatus.mockReturnValue({ running: false, state: baseState, recentActivity: [] });

    await run("sync", "--status", "--json");

    const parsed = JSON.parse(allOutput());
    expect(parsed.running).toBe(false);
    expect(parsed.state.watermark).toBeNull();
    expect(mockRunSync).not.toHaveBeenCalled();
  });

  it("tolerates a running lock without a start time", async () => {
    mockGetSyncStatus.mockReturnValue({
      running: true,
      pid: 11,
      state: baseState,
      recentActivity: [],
    });

    await run("sync", "--status");

    // An unparseable timestamp is echoed back verbatim (here: empty).
    expect(allOutput()).toContain("Sync running \u00B7 pid 11, started .");
  });

  it("echoes a future timestamp instead of a negative age", async () => {
    const future = new Date(Date.now() + 60 * 60_000).toISOString();
    mockGetSyncStatus.mockReturnValue({
      running: false,
      state: { ...baseState, watermark: future },
      recentActivity: [],
    });

    await run("sync", "--status");

    expect(allOutput()).toContain(`Studied through: ${future} (${future})`);
  });

  it("renders an hours-old timestamp with the minute remainder", async () => {
    mockGetSyncStatus.mockReturnValue({
      running: false,
      state: { ...baseState, watermark: new Date(Date.now() - 125 * 60_000).toISOString() },
      recentActivity: [],
    });

    await run("sync", "--status");

    expect(allOutput()).toContain("2h 5m ago");
  });

  it("shows the study scope with the home directory abbreviated", async () => {
    const home = homedir();
    mockGetSyncStatus.mockReturnValue({
      running: false,
      state: { ...baseState, project_filter: [`${home}/work/dosu-cli`, "/srv/other"] },
      recentActivity: [],
    });

    await run("sync", "--status");

    expect(allOutput()).toContain("Study scope:     ~/work/dosu-cli, /srv/other");
  });

  it("omits the study scope when the project filter is empty", async () => {
    mockGetSyncStatus.mockReturnValue({
      running: false,
      state: { ...baseState, project_filter: [] },
      recentActivity: [],
    });

    await run("sync", "--status");

    expect(allOutput()).not.toContain("Study scope");
  });

  it("omits the token tally when nothing has been distilled yet", async () => {
    mockGetSyncStatus.mockReturnValue({
      running: false,
      state: { ...baseState, total_notes: 3 },
      recentActivity: [],
    });

    await run("sync", "--status");

    const output = allOutput();
    expect(output).toContain("Suggested pages: 3 (from 0 sessions)");
    expect(output).not.toContain("tokens distilled");
  });

  it("uses the singular for a single failure in the backoff notice", async () => {
    mockGetSyncStatus.mockReturnValue({
      running: false,
      state: { ...baseState, consecutive_failures: 1 },
      backoffUntil: "2026-09-02T23:00:00.000Z",
      recentActivity: [],
    });

    await run("sync", "--status");

    expect(allOutput()).toContain("Backing off after 1 failure;");
  });
});

describe("knowledge hooks", () => {
  const claude = (): FakeAgent => ({
    id: "claude",
    name: "Claude Code",
    installed: true,
    enabled: false,
    configPath: "/home/u/.claude/settings.json",
  });
  const cursor = (): FakeAgent => ({
    id: "cursor",
    name: "Cursor",
    installed: false,
    enabled: false,
    configPath: "/home/u/.cursor/hooks.json",
  });

  // The PATH warning depends on the machine running the tests; pin PATH to a
  // scratch bin dir that does contain `dosu` so every test starts from "on PATH".
  const savedEnv: { PATH?: string; DOSU_DEV?: string } = {};
  let binDir: string;

  beforeEach(() => {
    savedEnv.PATH = process.env.PATH;
    savedEnv.DOSU_DEV = process.env.DOSU_DEV;
    binDir = mkdtempSync(join(tmpdir(), "dosu-hooks-test-"));
    writeFileSync(join(binDir, "dosu"), "");
    writeFileSync(join(binDir, "dosu.cmd"), "");
    process.env.PATH = binDir;
    delete process.env.DOSU_DEV;
  });

  afterEach(() => {
    if (savedEnv.PATH === undefined) delete process.env.PATH;
    else process.env.PATH = savedEnv.PATH;
    if (savedEnv.DOSU_DEV === undefined) delete process.env.DOSU_DEV;
    else process.env.DOSU_DEV = savedEnv.DOSU_DEV;
    rmSync(binDir, { recursive: true, force: true });
  });

  it("status lists every agent with its state", async () => {
    fakeAgents = [{ ...claude(), enabled: true }, cursor()];

    await run("hooks", "status");

    const output = allOutput();
    expect(output).toContain("claude");
    expect(output).toContain("enabled");
    expect(output).toContain("not installed");
  });

  it("status --json emits rows", async () => {
    fakeAgents = [claude()];

    await run("hooks", "status", "--json");

    const rows = JSON.parse(allOutput());
    expect(rows).toEqual([
      expect.objectContaining({ agent: "claude", installed: true, enabled: false }),
    ]);
  });

  it("status surfaces per-agent config errors as notes", async () => {
    fakeAgents = [
      { ...claude(), enabledError: new HookConfigError("settings.json is not valid JSON") },
    ];

    await run("hooks", "status");

    expect(allOutput()).toContain("not valid JSON");
    expect(process.exitCode).toBeUndefined();
  });

  it("status stringifies non-Error probe failures", async () => {
    fakeAgents = [{ ...claude(), enabledError: "permission denied" }];

    await run("hooks", "status", "--json");

    expect(JSON.parse(allOutput())).toEqual([
      expect.objectContaining({ agent: "claude", enabled: false, note: "permission denied" }),
    ]);
  });

  it("enable targets named agents", async () => {
    fakeAgents = [claude(), cursor()];

    await run("hooks", "enable", "claude");

    expect(enableCalls).toEqual(["claude"]);
    expect(allOutput()).toContain("hook enabled");
  });

  it("enable with no args targets all installed agents", async () => {
    fakeAgents = [claude(), cursor()];

    await run("hooks", "enable");

    expect(enableCalls).toEqual(["claude"]);
  });

  it("enable prints the agent's note when present", async () => {
    fakeAgents = [{ ...claude(), id: "codex", name: "Codex", note: "Approve the trust prompt." }];

    await run("hooks", "enable", "codex");

    expect(allOutput()).toContain("Approve the trust prompt.");
  });

  it("enable reports unknown agents", async () => {
    fakeAgents = [claude()];

    await run("hooks", "enable", "zed");

    expect(errorSpy.mock.calls.join(" ")).toContain("unknown agent 'zed'");
    expect(process.exitCode).toBe(1);
    expect(enableCalls).toEqual([]);
  });

  it("enable reports hook config failures without aborting the command", async () => {
    fakeAgents = [
      { ...claude(), enableError: new HookConfigError("settings.json is not valid JSON") },
      cursor(),
    ];

    await run("hooks", "enable", "claude", "cursor");

    expect(errorSpy.mock.calls.join(" ")).toContain(
      "✗ Claude Code: settings.json is not valid JSON",
    );
    expect(process.exitCode).toBe(1);
    // The failure is per-agent: the next agent is still enabled.
    expect(enableCalls).toEqual(["cursor"]);
  });

  it("enable reports plain errors and non-Error throws", async () => {
    fakeAgents = [
      { ...claude(), enableError: new Error("EACCES: permission denied") },
      { ...cursor(), installed: true, enableError: "weird failure" },
    ];

    await run("hooks", "enable", "claude", "cursor");

    const errors = errorSpy.mock.calls.join("\n");
    expect(errors).toContain("✗ Claude Code: EACCES: permission denied");
    expect(errors).toContain("✗ Cursor: weird failure");
    expect(process.exitCode).toBe(1);
  });

  it("enable does not warn when dosu resolves on PATH", async () => {
    fakeAgents = [claude()];

    await run("hooks", "enable");

    expect(allOutput()).not.toContain("not on PATH");
    expect(allOutput()).not.toContain("Dev mode");
  });

  it("enable warns when dosu is not on PATH", async () => {
    fakeAgents = [claude()];
    process.env.PATH = `${tmpdir()}${delimiter}`;

    await run("hooks", "enable");

    expect(allOutput()).toContain("'dosu' is not on PATH");
    expect(enableCalls).toEqual(["claude"]);
  });

  it("enable treats an unset PATH as empty", async () => {
    fakeAgents = [claude()];
    delete process.env.PATH;

    await run("hooks", "enable");

    expect(allOutput()).toContain("'dosu' is not on PATH");
  });

  it("enable looks for dosu.cmd on Windows", async () => {
    fakeAgents = [claude()];
    rmSync(join(binDir, "dosu"));
    const platform = Object.getOwnPropertyDescriptor(process, "platform");
    Object.defineProperty(process, "platform", { value: "win32", configurable: true });
    try {
      await run("hooks", "enable");
    } finally {
      if (platform) Object.defineProperty(process, "platform", platform);
    }

    expect(allOutput()).not.toContain("not on PATH");
  });

  it("enable skips the PATH warning when no agents were resolved", async () => {
    fakeAgents = [claude()];
    process.env.PATH = "";

    await run("hooks", "enable", "zed");

    expect(allOutput()).not.toContain("not on PATH");
    expect(process.exitCode).toBe(1);
  });

  it("enable in dev mode announces the pinned hook command instead of checking PATH", async () => {
    fakeAgents = [claude()];
    process.env.DOSU_DEV = "true";
    process.env.PATH = "";

    await run("hooks", "enable");

    const output = allOutput();
    expect(output).toContain("Dev mode: hooks will run ");
    expect(output).toContain("knowledge sync --quiet --detach");
    expect(output).not.toContain("not on PATH");
    expect(enableCalls).toEqual(["claude"]);
  });

  it("disable targets named agents", async () => {
    fakeAgents = [claude(), cursor()];

    await run("hooks", "disable", "claude");

    expect(disableCalls).toEqual(["claude"]);
    expect(allOutput()).toContain("hook disabled");
  });

  it("disable reports per-agent failures and keeps going", async () => {
    fakeAgents = [
      { ...claude(), disableError: new HookConfigError("settings.json is not valid JSON") },
      { ...cursor(), installed: true },
    ];

    await run("hooks", "disable");

    expect(errorSpy.mock.calls.join(" ")).toContain(
      "✗ Claude Code: settings.json is not valid JSON",
    );
    expect(disableCalls).toEqual(["cursor"]);
    expect(process.exitCode).toBe(1);
  });

  it("prints a hint when nothing is detected", async () => {
    fakeAgents = [cursor()];

    await run("hooks", "enable");

    expect(allOutput()).toContain("No supported agents detected");
  });
});

describe("knowledge backfill-transcripts", () => {
  it("reports the attribution counts after a run", async () => {
    mockLoadConfig.mockReturnValue(validConfig);
    mockRunBackfill.mockResolvedValue({
      candidates: 10,
      mappings: [{ note_id: "n1", transcript_id: "s1" }],
      ambiguous: 3,
      noBatch: 2,
      updated: 5,
    });

    await run("backfill-transcripts");

    expect(mockRunBackfill).toHaveBeenCalledTimes(1);
    const out = allOutput();
    expect(out).toContain("Attributed 5 of 10 notes");
    expect(out).toContain("3 ambiguous");
    expect(out).toContain("2 without a local study batch");
  });

  it("says nothing to do when every note is already attributed", async () => {
    mockLoadConfig.mockReturnValue(validConfig);
    mockRunBackfill.mockResolvedValue({
      candidates: 0,
      mappings: [],
      ambiguous: 0,
      noBatch: 0,
      updated: 0,
    });

    await run("backfill-transcripts");

    expect(allOutput()).toContain("already have a transcript");
  });

  it("emits JSON with --json", async () => {
    mockLoadConfig.mockReturnValue(validConfig);
    const result = { candidates: 2, mappings: [], ambiguous: 1, noBatch: 1, updated: 0 };
    mockRunBackfill.mockResolvedValue(result);

    await run("backfill-transcripts", "--json");

    expect(JSON.parse(allOutput())).toMatchObject(result);
  });
});
