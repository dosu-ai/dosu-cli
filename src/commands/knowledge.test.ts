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
// (SHIP_BATCH_LIMIT) keeps its production value.
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
vi.mock("../sync/status", () => ({
  getSyncStatus: (...args: unknown[]) => mockGetSyncStatus(...args),
}));

const mockListBacklog = vi.fn();
vi.mock("../sync/backlog", () => ({
  listSessionBacklog: (...args: unknown[]) => mockListBacklog(...args),
}));

const mockLoadSyncState = vi.fn();
const mockSetShipTranscripts = vi.fn();
vi.mock("../sync/watermark", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../sync/watermark")>()),
  loadSyncState: (...args: unknown[]) => mockLoadSyncState(...args),
  setShipTranscripts: (...args: unknown[]) => mockSetShipTranscripts(...args),
}));

const mockEmitReport = vi.fn();
const mockBuildReport = vi.fn();
vi.mock("../report/generate", () => ({
  DEFAULT_REPORT_DAYS: 30,
  emitKnowledgeReport: (...args: unknown[]) => mockEmitReport(...args),
  buildKnowledgeReport: (...args: unknown[]) => mockBuildReport(...args),
}));

const mockCreateShipStep = vi.fn();
vi.mock("../shipper/runner", () => ({
  createShipStep: (...args: unknown[]) => mockCreateShipStep(...args),
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
import { SHIP_BATCH_LIMIT } from "../sync/sync";
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
  mockBuildReport.mockReset();
  mockEmitReport.mockResolvedValue("/tmp/dosu-memory-report.html");
  mockSetShipTranscripts.mockReset();
  mockCreateShipStep.mockReset();
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
    schema_version: 2,
    watermark: "2026-09-02T23:00:00.000Z",
    consecutive_failures: 0,
    shipped_sessions: [
      {
        at: "2026-09-02T23:00:00.000Z",
        session: "cursor/1d4b4ea0-e555-4444-8888-abcdefabcdef",
        task_id: "task-1",
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
    expect(out).toContain("Shipped (1)");
    // The whole point of the command: nothing is clipped.
    expect(out).toContain(queuedSession.id);
    expect(out).toContain(queuedSession.project);
    expect(out).toContain(openSession.id);
    expect(out).toContain("1d4b4ea0-e555-4444-8888-abcdefabcdef");
    expect(out).not.toContain("\u2026");
    // Shipped history's "harness/id" splits back into columns.
    expect(out).not.toContain("cursor/1d4b4ea0");
  });

  it("shows per-section empty messages", async () => {
    mockListBacklog.mockReturnValue({ queued: [], open: [] });
    mockLoadSyncState.mockReturnValue({ ...syncState, shipped_sessions: [] });

    await run("sessions");

    const out = allOutput();
    expect(out).toContain("Queue empty.");
    expect(out).toContain("No open sessions.");
    expect(out).toContain("No sessions shipped yet.");
  });

  it("--queued lists only the queue and never reads the sync state", async () => {
    mockListBacklog.mockReturnValue({ queued: [queuedSession], open: [openSession] });

    await run("sessions", "--queued");

    const out = allOutput();
    expect(out).toContain("Queued (1)");
    expect(out).not.toContain("Open (");
    expect(out).not.toContain("Shipped (");
    expect(mockLoadSyncState).not.toHaveBeenCalled();
  });

  it("--shipped alone skips the session scan", async () => {
    mockLoadSyncState.mockReturnValue(syncState);

    await run("sessions", "--shipped");

    expect(mockListBacklog).not.toHaveBeenCalled();
    expect(allOutput()).toContain("Shipped (1)");
  });

  it("--json emits only the requested sections", async () => {
    mockListBacklog.mockReturnValue({ queued: [queuedSession], open: [openSession] });

    await run("sessions", "--queued", "--open", "--json");

    const parsed = JSON.parse(allOutput());
    expect(parsed).toEqual({ queued: [queuedSession], open: [openSession] });
    expect(parsed.shipped).toBeUndefined();
  });

  it("--shipped --json emits only the shipped history", async () => {
    mockLoadSyncState.mockReturnValue(syncState);

    await run("sessions", "--shipped", "--json");

    expect(JSON.parse(allOutput())).toEqual({ shipped: syncState.shipped_sessions });
    expect(mockListBacklog).not.toHaveBeenCalled();
  });

  it("treats a sync state without shipped_sessions as empty history", async () => {
    mockListBacklog.mockReturnValue({ queued: [], open: [] });
    mockLoadSyncState.mockReturnValue({ schema_version: 2, watermark: null });

    await run("sessions");

    expect(allOutput()).toContain("Shipped (0)");
  });

  it("keeps shipped records that lack a harness prefix or project", async () => {
    mockLoadSyncState.mockReturnValue({
      ...syncState,
      shipped_sessions: [
        { at: "2026-09-01T00:00:00.000Z", session: "bare-session-id", task_id: "t" },
      ],
    });

    await run("sessions", "--shipped");

    const out = allOutput();
    expect(out).toContain("Shipped (1)");
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
    // Authenticated cloud-mode install with a backend: sync builds a ship step.
    mockLoadConfig.mockReturnValue(makeValidConfig({ deployment_id: "dep1" }));
    process.env.DOSU_BACKEND_URL_OVERRIDE = "https://api.dosu.test";
  });

  afterEach(() => {
    delete process.env.DOSU_BACKEND_URL_OVERRIDE;
  });

  it("prints the backlog when there is nothing to ship with", async () => {
    mockRunSync.mockResolvedValue({ status: "backlog", readySessions: 3, inFlightSessions: 1 });

    await run("sync");

    expect(mockRunSync.mock.calls[0][0].quiet).toBeUndefined();
    const output = allOutput();
    expect(output).toContain("3 finished sessions ready to ship");
    expect(output).toContain("1 more still in progress");
  });

  it("reports a shipped run with what was passed over and the remaining backlog", async () => {
    mockRunSync.mockResolvedValue({
      status: "shipped",
      readySessions: 8,
      inFlightSessions: 0,
      sessions: [],
      settledSessions: 5,
      counts: { shipped: 3, incognito: 1, trivial: 1, scratch: 0, skipped: 0, failed: 0 },
    });

    await run("sync");

    const output = allOutput();
    expect(output).toContain("Shipped 3 sessions to Dosu memory");
    expect(output).toContain("2 passed over");
    expect(output).toContain("3 more in the backlog");
    expect(process.exitCode).toBeUndefined();
  });

  it("uses singulars and omits the passed-over note when nothing was skipped", async () => {
    mockRunSync.mockResolvedValue({
      status: "shipped",
      readySessions: 1,
      inFlightSessions: 0,
      sessions: [],
      settledSessions: 1,
      counts: { shipped: 1, incognito: 0, trivial: 0, scratch: 0, skipped: 0, failed: 0 },
    });

    await run("sync");

    const output = allOutput();
    expect(output).toContain("Shipped 1 session to Dosu memory.");
    expect(output).not.toContain("passed over");
    expect(output).not.toContain("more in the backlog");
  });

  it("ship-failed says it will retry and sets the exit code", async () => {
    mockRunSync.mockResolvedValue({
      status: "ship-failed",
      readySessions: 4,
      inFlightSessions: 0,
      sessions: [],
      settledSessions: 1,
      counts: { shipped: 1, incognito: 0, trivial: 0, scratch: 0, skipped: 0, failed: 1 },
      error: "502 Bad Gateway",
    });

    await run("sync");

    const output = allOutput();
    expect(output).toContain("Shipped 1 session to Dosu memory.");
    expect(output).toContain("Shipping stopped: 502 Bad Gateway. It will be retried.");
    expect(process.exitCode).toBe(1);
  });

  it("explains a disabled install and how to turn shipping back on", async () => {
    mockRunSync.mockResolvedValue({ status: "disabled", readySessions: 0, inFlightSessions: 0 });

    await run("sync");

    expect(allOutput()).toContain("'dosu knowledge transcripts enable'");
    expect(process.exitCode).toBeUndefined();
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

    expect(allOutput()).toContain("No new finished sessions");
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
    expect(output).toContain("1 finished session ready to ship.");
    expect(output).not.toContain("still in progress");
  });

  it("explains a skipped-paused run", async () => {
    mockRunSync.mockResolvedValue({
      status: "skipped-paused",
      readySessions: 0,
      inFlightSessions: 0,
    });

    await run("sync");

    expect(allOutput()).toContain("syncing is paused");
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

    expect(allOutput()).toContain("No new finished sessions");
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

  it("knowledge report --json prints the report data and writes no HTML", async () => {
    mockBuildReport.mockResolvedValue({ days: 7, sessions: [], memories: [] });

    await run("report", "--json", "--days", "7");

    expect(mockBuildReport).toHaveBeenCalledWith({ days: 7 });
    expect(mockEmitReport).not.toHaveBeenCalled();
    expect(JSON.parse(allOutput())).toEqual({ days: 7, sessions: [], memories: [] });
  });

  it("knowledge report opens the last 30 days in the browser by default", async () => {
    await run("report");

    expect(mockEmitReport).toHaveBeenCalledWith({ days: 30, out: undefined, open: true });
  });

  it("knowledge report explains what it needs instead of a stack trace", async () => {
    mockEmitReport.mockRejectedValue(
      new Error("Not connected to a Dosu organization. Run `dosu setup` first."),
    );

    await run("report");

    expect(errorSpy.mock.calls.join(" ")).toContain("Run `dosu setup` first.");
    expect(process.exitCode).toBe(1);
  });

  it("--report writes and opens the harvest HTML after a foreground sync", async () => {
    mockLoadConfig.mockReturnValue(makeValidConfig({ deployment_id: "dep1" }));
    mockRunSync.mockResolvedValue({
      status: "shipped",
      readySessions: 2,
      inFlightSessions: 0,
      sessions: [],
      settledSessions: 2,
      counts: { shipped: 2, incognito: 0, trivial: 0, scratch: 0, skipped: 0, failed: 0 },
    });

    await run("sync", "--report", "--out", "/tmp/custom-report.html");

    expect(mockEmitReport).toHaveBeenCalledWith({
      out: "/tmp/custom-report.html",
      open: true,
    });
    expect(allOutput()).toContain("Wrote /tmp/dosu-memory-report.html");
  });

  it("knowledge report writes the HTML without running sync", async () => {
    mockLoadConfig.mockReturnValue(makeValidConfig({ deployment_id: "dep1" }));
    await run("report", "--no-open");
    expect(mockRunSync).not.toHaveBeenCalled();
    expect(mockEmitReport).toHaveBeenCalledWith({
      days: 30,
      out: undefined,
      open: false,
    });
    expect(allOutput()).toContain("Wrote /tmp/dosu-memory-report.html");
  });

  it("--quiet --report stays silent and does not write HTML", async () => {
    mockRunSync.mockResolvedValue({ status: "shipped", readySessions: 0, inFlightSessions: 0 });
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
      report: "/tmp/dosu-memory-report.html",
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

  /** A round that shipped `settled` of `ready` sessions (5 per round by default). */
  function shippedOutcome(ready: number, settled = Math.min(ready, 5)) {
    return {
      status: "shipped",
      readySessions: ready,
      inFlightSessions: 0,
      sessions: [],
      settledSessions: settled,
      counts: { shipped: settled, incognito: 0, trivial: 0, scratch: 0, skipped: 0, failed: 0 },
    };
  }

  describe("analytics facets", () => {
    it("tags a hook-triggered ship run with its status and bucketable count", async () => {
      mockRunSync.mockResolvedValue(shippedOutcome(8));

      await run("sync", "--quiet");

      expect(consumeCommandFacets()).toEqual({
        sync_trigger: "hook",
        sync_status: "shipped",
        sessions_shipped: 5,
      });
    });

    it("tags a manual run that only reported the backlog", async () => {
      mockRunSync.mockResolvedValue({ status: "backlog", readySessions: 3, inFlightSessions: 1 });

      await run("sync");

      expect(consumeCommandFacets()).toEqual({
        sync_trigger: "manual",
        sync_status: "backlog",
        sessions_shipped: 0,
      });
    });

    it("sums shipped sessions across bootstrap rounds and keeps the final status", async () => {
      mockRunSync
        .mockResolvedValueOnce(shippedOutcome(8))
        .mockResolvedValueOnce(shippedOutcome(3))
        .mockResolvedValue({ status: "nothing-new", readySessions: 0, inFlightSessions: 0 });

      await run("sync", "--bootstrap");

      expect(consumeCommandFacets()).toEqual({
        sync_trigger: "bootstrap",
        sync_status: "shipped",
        sessions_shipped: 8,
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
        state: { schema_version: 2, watermark: null, consecutive_failures: 0 },
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
    mockRunSync.mockResolvedValueOnce(shippedOutcome(8)).mockResolvedValue(shippedOutcome(3));

    await run("sync", "--bootstrap");

    expect(mockRunSync).toHaveBeenCalledTimes(2);
    for (const call of mockRunSync.mock.calls) {
      expect(call[0].bootstrap).toBe(true);
    }
  });

  it("--bootstrap drains the backlog round by round and reports each round", async () => {
    mockRunSync.mockResolvedValueOnce(shippedOutcome(8)).mockResolvedValue(shippedOutcome(3));

    await run("sync", "--bootstrap");

    const output = allOutput();
    expect(output).toContain("Shipped 5 sessions");
    expect(output).toContain("Shipped 3 sessions");
  });

  it("--bootstrap stops once a round settles the whole remaining backlog", async () => {
    mockRunSync.mockResolvedValue(shippedOutcome(3));

    await run("sync", "--bootstrap");

    expect(mockRunSync).toHaveBeenCalledTimes(1);
  });

  it("--bootstrap stops the drain on a failed round", async () => {
    mockRunSync.mockResolvedValueOnce(shippedOutcome(8)).mockResolvedValue({
      ...shippedOutcome(3, 0),
      status: "ship-failed",
      error: "backend down",
    });

    await run("sync", "--bootstrap");

    expect(mockRunSync).toHaveBeenCalledTimes(2);
    expect(allOutput()).toContain("Shipping stopped: backend down");
    expect(process.exitCode).toBe(1);
  });

  it("--bootstrap stops when a round settles nothing", async () => {
    mockRunSync.mockResolvedValue(shippedOutcome(8, 0));

    await run("sync", "--bootstrap");

    expect(mockRunSync).toHaveBeenCalledTimes(1);
  });

  it("--bootstrap --quiet drains silently", async () => {
    mockRunSync.mockResolvedValueOnce(shippedOutcome(8)).mockResolvedValue(shippedOutcome(3));

    await run("sync", "--quiet", "--bootstrap");

    expect(mockRunSync).toHaveBeenCalledTimes(2);
    expect(logSpy).not.toHaveBeenCalled();
  });

  it("--bootstrap is capped even if every round reports more", async () => {
    // Every round claims two batches' worth of sessions are still ready; the
    // cap comes from the first round's backlog: ceil(ready/batch)+2 rounds.
    const ready = SHIP_BATCH_LIMIT * 2;
    mockRunSync.mockResolvedValue(shippedOutcome(ready));

    await run("sync", "--bootstrap");

    expect(mockRunSync).toHaveBeenCalledTimes(Math.ceil(ready / SHIP_BATCH_LIMIT) + 2);
  });

  it("--bootstrap without a ship step stays single-shot", async () => {
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
  const baseState = { schema_version: 2, watermark: null, consecutive_failures: 0 };

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
    expect(out).toContain("Syncing paused: stopped by you");
    expect(out).toContain("'dosu knowledge sync'");
  });

  it("points a disabled install at the switch", async () => {
    mockGetSyncStatus.mockReturnValue({
      running: false,
      state: { ...baseState, ship_transcripts: false },
      recentActivity: [],
    });

    await run("sync", "--status");

    expect(allOutput()).toContain("Shipping disabled. Turn it on with");
  });

  it("reports a running sync without scanning or shipping", async () => {
    mockGetSyncStatus.mockReturnValue({
      running: true,
      pid: 4242,
      startedAt: new Date(Date.now() - 3 * 60_000).toISOString(),
      state: {
        ...baseState,
        watermark: new Date(Date.now() - 2 * 86_400_000).toISOString(),
        total_shipped: 12,
      },
      recentActivity: ["[t] [sync] shipped session claude/abc → task t1"],
    });

    await run("sync", "--status");

    const output = allOutput();
    expect(output).toContain("Sync running \u00B7 pid 4242");
    expect(output).toContain("3m ago");
    expect(output).toContain("Shipped through:");
    expect(output).toContain("2d ago");
    expect(output).toContain("Shipped:         12 sessions");
    expect(output).toContain("shipped session claude/abc");
    expect(output).toContain("logs --follow");
    expect(mockRunSync).not.toHaveBeenCalled();
  });

  it("reports idle with nothing shipped yet", async () => {
    mockGetSyncStatus.mockReturnValue({ running: false, state: baseState, recentActivity: [] });

    await run("sync", "--status");

    const output = allOutput();
    expect(output).toContain("No sync running");
    expect(output).toContain("nothing shipped yet");
    expect(output).not.toContain("Shipped:");
    expect(output).not.toContain("Shipping disabled");
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

    expect(allOutput()).toContain(`Shipped through: ${future} (${future})`);
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

  it("shows the scope with the home directory abbreviated", async () => {
    const home = homedir();
    mockGetSyncStatus.mockReturnValue({
      running: false,
      state: { ...baseState, project_filter: [`${home}/work/dosu-cli`, "/srv/other"] },
      recentActivity: [],
    });

    await run("sync", "--status");

    expect(allOutput()).toContain("Scope:           ~/work/dosu-cli, /srv/other");
  });

  it("omits the scope when the project filter is empty", async () => {
    mockGetSyncStatus.mockReturnValue({
      running: false,
      state: { ...baseState, project_filter: [] },
      recentActivity: [],
    });

    await run("sync", "--status");

    expect(allOutput()).not.toContain("Scope:");
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

describe("knowledge sync shipping wiring", () => {
  beforeEach(() => {
    mockLoadConfig.mockReturnValue(makeValidConfig({ deployment_id: "dep1" }));
    mockRunSync.mockResolvedValue({ status: "nothing-new", readySessions: 0, inFlightSessions: 0 });
    process.env.DOSU_BACKEND_URL_OVERRIDE = "https://api.dosu.test";
  });

  afterEach(() => {
    delete process.env.DOSU_BACKEND_URL_OVERRIDE;
  });

  function syncDeps(call = 0): { ship?: unknown } {
    return mockRunSync.mock.calls[call][0].deps;
  }

  it("builds a ship step for an authenticated cloud install", async () => {
    await run("sync");
    expect(typeof syncDeps().ship).toBe("function");
  });

  it("does not build a ship step without an API key", async () => {
    mockLoadConfig.mockReturnValue(makeValidConfig({ api_key: undefined }));
    await run("sync");
    expect(syncDeps().ship).toBeUndefined();
  });

  it("does not build a ship step without a deployment", async () => {
    mockLoadConfig.mockReturnValue(makeValidConfig({ deployment_id: undefined }));
    await run("sync");
    expect(syncDeps().ship).toBeUndefined();
  });

  it("does not build a ship step in OSS mode", async () => {
    mockLoadConfig.mockReturnValue(makeValidConfig({ deployment_id: "dep1", mode: "oss" }));
    await run("sync");
    expect(syncDeps().ship).toBeUndefined();
  });

  it("does not build a ship step without a backend URL", async () => {
    delete process.env.DOSU_BACKEND_URL_OVERRIDE;
    await run("sync");
    expect(syncDeps().ship).toBeUndefined();
  });

  it("the ship step forwards the install's credentials to the shipper", async () => {
    const inner = vi.fn().mockResolvedValue([]);
    mockCreateShipStep.mockReturnValue(inner);

    await run("sync");

    const ship = syncDeps().ship as (sessions: unknown[]) => Promise<unknown>;
    const sessions = [{ id: "s1", harness: "claude", path: "/tmp/s1.jsonl", updated: "now" }];
    await expect(ship(sessions)).resolves.toEqual([]);
    expect(mockCreateShipStep).toHaveBeenCalledWith({
      apiKey: "sk_user_test",
      deploymentId: "dep1",
    });
    expect(inner).toHaveBeenCalledWith(sessions);
  });
});

describe("knowledge transcripts", () => {
  it("enable clears the opt-out and explains what is collected", async () => {
    await run("transcripts", "enable");

    expect(mockSetShipTranscripts).toHaveBeenCalledWith(true);
    const output = allOutput();
    expect(output).toContain("Transcript shipping enabled.");
    expect(output).toContain("redacted locally");
    expect(output).toContain("/dosu-incognito");
  });

  it("disable records the opt-out", async () => {
    await run("transcripts", "disable");

    expect(mockSetShipTranscripts).toHaveBeenCalledWith(false);
    expect(allOutput()).toContain("Transcript shipping disabled.");
  });

  it("status shows the opt-out", async () => {
    mockLoadSyncState.mockReturnValue({
      schema_version: 2,
      watermark: null,
      consecutive_failures: 0,
      ship_transcripts: false,
    });

    await run("transcripts", "status");

    expect(allOutput()).toContain("Transcript shipping is disabled.");
  });

  it("status shows the default and recent session links", async () => {
    mockLoadSyncState.mockReturnValue({
      schema_version: 2,
      watermark: "2026-09-01T00:00:00.000Z",
      consecutive_failures: 0,
      total_shipped: 3,
      shipped_sessions: [
        {
          at: "2026-09-01T00:00:00.000Z",
          session: "claude/abc",
          task_id: "task-1",
          session_url: "https://app/memories/sessions/abc",
        },
      ],
    });

    await run("transcripts", "status");

    const output = allOutput();
    expect(output).toContain("Transcript shipping is enabled (the default).");
    expect(output).toContain("Shipped:         3 sessions");
    expect(output).toContain("Shipped through: 2026-09-01T00:00:00.000Z");
    expect(output).toContain("claude/abc · https://app/memories/sessions/abc");
  });

  it("status --json emits the machine-readable state", async () => {
    mockLoadSyncState.mockReturnValue({
      schema_version: 2,
      watermark: "2026-09-01T00:00:00.000Z",
      consecutive_failures: 0,
      total_shipped: 1,
      shipped_sessions: [
        { at: "2026-09-01T00:00:00.000Z", session: "claude/abc", task_id: "task-1" },
      ],
    });

    await run("transcripts", "status", "--json");

    expect(JSON.parse(allOutput())).toEqual({
      enabled: true,
      total_shipped: 1,
      watermark: "2026-09-01T00:00:00.000Z",
      shipped_sessions: [
        { at: "2026-09-01T00:00:00.000Z", session: "claude/abc", task_id: "task-1" },
      ],
    });
  });
});

describe("knowledge context (prompt-submit hook)", () => {
  // The hook runs while the user's prompt waits. An install that cannot ask Dosu anything must
  // say nothing and never touch stdin or the network.
  it.each([
    ["OSS mode", { mode: "oss", active_account: { target: { api_key: "k", deployment_id: "d" } } }],
    ["no API key", { mode: "cloud", active_account: { target: { deployment_id: "d" } } }],
    ["no deployment", { mode: "cloud", active_account: { target: { api_key: "k" } } }],
    ["logged out", { mode: "cloud" }],
  ])("is silent with %s", async (_label, config) => {
    mockLoadConfig.mockReturnValue(config);
    const write = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    const fetchSpy = vi.spyOn(globalThis, "fetch");
    await run("context");
    expect(write).not.toHaveBeenCalled();
    expect(fetchSpy).not.toHaveBeenCalled();
    write.mockRestore();
    fetchSpy.mockRestore();
  });
});
