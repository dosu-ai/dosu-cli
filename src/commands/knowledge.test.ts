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
vi.mock("../sync/sync", () => ({
  runKnowledgeSync: (...args: unknown[]) => mockRunSync(...args),
}));

const mockSpawnDetached = vi.fn();
vi.mock("../sync/detach", () => ({
  spawnDetachedSelf: (...args: unknown[]) => mockSpawnDetached(...args),
}));

interface FakeAgent {
  id: string;
  name: string;
  installed: boolean;
  enabled: boolean;
  configPath: string;
  enableError?: Error;
  enabledError?: Error;
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

import { type FlatTestConfig, makeTestConfig } from "../config/config.test-utils";
import { HookConfigError } from "../hooks/formats";
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
  fakeAgents = [];
  enableCalls.length = 0;
  disableCalls.length = 0;
  logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
  errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
  exitSpy = vi.spyOn(process, "exit").mockImplementation((() => {
    throw new Error("exit");
  }) as never);
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

describe("knowledge sync", () => {
  beforeEach(() => {
    // Authenticated cloud-mode install: sync should build a miner.
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
    expect(allOutput()).toContain("3 new sessions ready to mine");
  });

  it("does not build a miner when the install has no API key", async () => {
    mockLoadConfig.mockReturnValue(makeValidConfig({ api_key: undefined }));
    mockRunSync.mockResolvedValue({ status: "backlog", readySessions: 1, inFlightSessions: 0 });

    await run("sync");

    expect(syncDeps().mine).toBeUndefined();
  });

  it("does not build a miner in OSS mode", async () => {
    mockLoadConfig.mockReturnValue(makeValidConfig({ deployment_id: "dep1", mode: "oss" }));
    mockRunSync.mockResolvedValue({ status: "backlog", readySessions: 1, inFlightSessions: 0 });

    await run("sync");

    expect(syncDeps().mine).toBeUndefined();
  });

  it("reports a mined run with the remaining backlog", async () => {
    mockRunSync.mockResolvedValue({
      status: "mined",
      readySessions: 8,
      inFlightSessions: 0,
      sessions: [],
      minedSessions: 5,
      miner: { outcome: "completed", notesWritten: 3, turns: 12 },
    });

    await run("sync");

    const output = allOutput();
    expect(output).toContain("Mined 5 sessions — 3 notes written");
    expect(output).toContain("3 more in the backlog");
  });

  it("renders the gateway's refusal message on skipped-gateway", async () => {
    mockRunSync.mockResolvedValue({
      status: "skipped-gateway",
      readySessions: 2,
      inFlightSessions: 0,
      sessions: [],
      minedSessions: 0,
      miner: { outcome: "consent_off", notesWritten: 0, turns: 0, message: "org opt-in is off" },
    });

    await run("sync");

    expect(allOutput()).toContain("org opt-in is off");
    expect(process.exitCode).toBeUndefined();
  });

  it("mine-failed prints the miner message and sets the exit code", async () => {
    mockRunSync.mockResolvedValue({
      status: "mine-failed",
      readySessions: 2,
      inFlightSessions: 0,
      sessions: [],
      minedSessions: 0,
      miner: { outcome: "error", notesWritten: 0, turns: 4, message: "run exploded" },
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

  it("--list is a dry run: no miner even when credentials exist", async () => {
    mockRunSync.mockResolvedValue({
      status: "backlog",
      readySessions: 1,
      inFlightSessions: 0,
      sessions: [],
    });

    await run("sync", "--list");

    expect(syncDeps().mine).toBeUndefined();
  });

  it("--list prints the selected sessions", async () => {
    mockRunSync.mockResolvedValue({
      status: "backlog",
      readySessions: 1,
      inFlightSessions: 0,
      sessions: [
        {
          id: "848b3896-fb07",
          harness: "cursor",
          path: "/home/u/.cursor/projects/p/agent-transcripts/848b3896-fb07/848b3896-fb07.jsonl",
          project: "Users-james-dosu-cli",
          updated: "2026-08-27T21:05:00.000Z",
        },
      ],
    });

    await run("sync", "--list");

    const output = allOutput();
    expect(output).toContain("cursor");
    expect(output).toContain("2026-08-27 21:05");
    expect(output).toContain("Users-james-dosu-cli");
    expect(output).toContain("848b3896-fb07");
  });

  it("--list prints no table when the backlog is empty", async () => {
    mockRunSync.mockResolvedValue({
      status: "nothing-new",
      readySessions: 0,
      inFlightSessions: 0,
      sessions: [],
    });

    await run("sync", "--list");

    expect(allOutput()).not.toContain("Agent");
  });

  it("--detach re-spawns and never runs the pipeline inline", async () => {
    await run("sync", "--quiet", "--detach");

    expect(mockSpawnDetached).toHaveBeenCalledWith(["knowledge", "sync", "--quiet"]);
    expect(mockRunSync).not.toHaveBeenCalled();
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
    ];

    await run("hooks", "enable", "claude");

    expect(errorSpy.mock.calls.join(" ")).toContain("not valid JSON");
    expect(process.exitCode).toBe(1);
  });

  it("disable targets named agents", async () => {
    fakeAgents = [claude(), cursor()];

    await run("hooks", "disable", "claude");

    expect(disableCalls).toEqual(["claude"]);
    expect(allOutput()).toContain("hook disabled");
  });

  it("prints a hint when nothing is detected", async () => {
    fakeAgents = [cursor()];

    await run("hooks", "enable");

    expect(allOutput()).toContain("No supported agents detected");
  });
});
