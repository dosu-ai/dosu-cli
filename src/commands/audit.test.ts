import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// ── tRPC client ──
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

// ── config ──
const mockLoadConfig = vi.fn();
vi.mock("../config/config", () => ({
  loadConfig: (...args: unknown[]) => mockLoadConfig(...args),
}));

// ── github-step ──
const mockDetectGitRepo = vi.fn();
const mockStepConnect = vi.fn();
vi.mock("../setup/github-step", () => ({
  detectGitRepo: (...a: unknown[]) => mockDetectGitRepo(...a),
  stepConnectGitHubRepo: (...a: unknown[]) => mockStepConnect(...a),
}));

// ── pending-tasks cache ──
const mockAddPendingTask = vi.fn();
vi.mock("../version/pending-tasks-check", () => ({
  addPendingTask: (...a: unknown[]) => mockAddPendingTask(...a),
}));

// ── fs (findings file) ──
const mockExistsSync = vi.fn();
const mockReadFileSync = vi.fn();
vi.mock("node:fs", () => ({
  existsSync: (...a: unknown[]) => mockExistsSync(...a),
  readFileSync: (...a: unknown[]) => mockReadFileSync(...a),
}));

// ── clack ──
const mockConfirm = vi.fn();
const mockMultiselect = vi.fn();
const mockIsCancel = vi.fn().mockReturnValue(false);
const mockSpinner = { start: vi.fn(), stop: vi.fn(), message: vi.fn() };
vi.mock("@clack/prompts", () => ({
  confirm: (...a: unknown[]) => mockConfirm(...a),
  multiselect: (...a: unknown[]) => mockMultiselect(...a),
  isCancel: (...a: unknown[]) => mockIsCancel(...a),
  spinner: () => mockSpinner,
  log: { info: vi.fn(), success: vi.fn(), error: vi.fn(), warn: vi.fn() },
}));

vi.mock("../debug/logger", () => ({
  logger: { debug: vi.fn(), error: vi.fn(), info: vi.fn(), warn: vi.fn() },
}));

const mockFetch = vi.fn();
vi.stubGlobal("fetch", mockFetch);

import { auditCommand } from "./audit";

let logSpy: ReturnType<typeof vi.spyOn>;
let errorSpy: ReturnType<typeof vi.spyOn>;
// biome-ignore lint/suspicious/noExplicitAny: process.exit mock type mismatch
let exitSpy: any;

const validConfig = {
  access_token: "t",
  refresh_token: "r",
  expires_at: 0,
  api_key: "sk_user_test",
  org_id: "org1",
  space_id: "sp1",
};

const detected = { owner: "o", name: "r", slug: "o/r" };

const findings = {
  version: 1,
  generated_at: "2026-01-01T00:00:00Z",
  repo: { remote: "git@github.com:o/r.git", slug: "o/r" },
  items: [
    {
      task: "generate-agents-md",
      type: "agents",
      file: "AGENTS.md",
      status: "missing",
      action: "create",
      can_help: true,
      confidence: "high",
      rationale: "no agents file",
      evidence: ["e1"],
    },
    {
      task: "generate-readme",
      type: "readme",
      file: "README.md",
      status: "present_ok",
      action: "skip",
      can_help: true,
      confidence: "low",
      rationale: "looks fine",
      evidence: [],
    },
    {
      task: "unsupported-thing",
      type: "deps",
      file: "DEPS.md",
      status: "missing",
      action: "create",
      can_help: true,
      confidence: "high",
      rationale: "n/a",
      evidence: [],
    },
  ],
};

const capabilities = {
  tasks: [
    { id: "generate-agents-md", label: "AGENTS.md", description: "", doc_type: "agents" },
    { id: "generate-readme", label: "README", description: "", doc_type: "readme" },
  ],
};

function jsonResp(data: unknown, ok = true): Response {
  return {
    ok,
    status: ok ? 200 : 500,
    json: async () => data,
  } as unknown as Response;
}

interface FetchInit {
  method?: string;
  headers: Record<string, string>;
  body: string;
}

function fetchCalls(): [string, FetchInit][] {
  return mockFetch.mock.calls as unknown as [string, FetchInit][];
}

function postCalls(): [string, FetchInit][] {
  return fetchCalls().filter((c) => c[1]?.method === "POST");
}

function setFindings(obj: unknown): void {
  mockExistsSync.mockReturnValue(true);
  mockReadFileSync.mockReturnValue(JSON.stringify(obj));
}

async function run(...args: string[]) {
  const cmd = auditCommand();
  cmd.exitOverride();
  await cmd.parseAsync(["node", "test", ...args]);
}

beforeEach(() => {
  vi.clearAllMocks();
  mockIsCancel.mockReturnValue(false);
  mockLoadConfig.mockReturnValue(validConfig);
  mockDetectGitRepo.mockReturnValue(detected);
  process.env.DOSU_BACKEND_URL_OVERRIDE = "https://api.example.test";
  logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
  errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
  exitSpy = vi.spyOn(process, "exit").mockImplementation((() => {
    throw new Error("exit");
  }) as never);
});

afterEach(() => {
  delete process.env.DOSU_BACKEND_URL_OVERRIDE;
  logSpy.mockRestore();
  errorSpy.mockRestore();
  exitSpy.mockRestore();
});

describe("config guard", () => {
  it("exits when api_key missing", async () => {
    mockLoadConfig.mockReturnValue({ ...validConfig, api_key: undefined });
    await expect(run()).rejects.toThrow("exit");
  });

  it("exits when org_id missing", async () => {
    mockLoadConfig.mockReturnValue({ ...validConfig, org_id: undefined });
    await expect(run()).rejects.toThrow("exit");
  });

  it("exits when not logged in", async () => {
    mockLoadConfig.mockReturnValue({ ...validConfig, access_token: "" });
    await expect(run()).rejects.toThrow("exit");
  });
});

describe("repo enforcement", () => {
  it("exits when not a git repo", async () => {
    mockDetectGitRepo.mockReturnValue(null);
    await expect(run()).rejects.toThrow("exit");
    expect(errorSpy.mock.calls.join(" ")).toContain("Not a GitHub repo");
  });

  it("prompts to connect when no matching data source, exits on decline", async () => {
    mockQuery.mockResolvedValueOnce([]); // dataSource.list — no match
    mockConfirm.mockResolvedValue(false);
    await expect(run()).rejects.toThrow("exit");
    expect(mockConfirm).toHaveBeenCalled();
    expect(mockStepConnect).not.toHaveBeenCalled();
  });

  it("handles a null dataSource.list result as no data sources", async () => {
    mockQuery.mockResolvedValue(null); // dataSource.list → null → `?? []`
    await expect(run("--tasks", "generate-agents-md")).rejects.toThrow("exit");
    expect(mockStepConnect).not.toHaveBeenCalled();
  });

  it("connects when accepted, then proceeds", async () => {
    // list #1 no match → confirm yes → connect → list #2 indexed match
    mockQuery
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([
        { data_source_id: "ds1", provider_slug: "github", name: "o/r", is_indexed: true },
      ]);
    mockConfirm.mockResolvedValue(true);
    mockStepConnect.mockResolvedValue({ has_connected_repo: true });
    setFindings(findings);
    mockFetch
      .mockResolvedValueOnce(jsonResp(capabilities)) // GET /cli/tasks
      .mockResolvedValueOnce(jsonResp({ task_id: "task-1" })); // POST
    mockMultiselect.mockResolvedValue(["generate-agents-md"]);

    await run();

    expect(mockStepConnect).toHaveBeenCalledWith(validConfig, detected);
    expect(mockAddPendingTask).toHaveBeenCalled();
  });

  it("polls until indexed when matched but not indexed", async () => {
    mockQuery
      .mockResolvedValueOnce([
        { data_source_id: "ds1", provider_slug: "github", name: "o/r", is_indexed: false },
      ])
      .mockResolvedValueOnce([
        { data_source_id: "ds1", provider_slug: "github", name: "o/r", is_indexed: true },
      ]);
    setFindings(findings);
    mockFetch
      .mockResolvedValueOnce(jsonResp(capabilities))
      .mockResolvedValueOnce(jsonResp({ task_id: "task-1" }));
    mockMultiselect.mockResolvedValue(["generate-agents-md"]);

    await run();

    // Two list calls = initial (not indexed) + one poll (indexed).
    const listCalls = mockQuery.mock.calls.filter((c) => c[0] === "dataSource.list");
    expect(listCalls.length).toBeGreaterThanOrEqual(2);
    expect(mockAddPendingTask).toHaveBeenCalled();
  });

  it("--data-source-id skips auto-match entirely", async () => {
    setFindings(findings);
    mockFetch
      .mockResolvedValueOnce(jsonResp(capabilities))
      .mockResolvedValueOnce(jsonResp({ task_id: "task-1" }));
    mockMultiselect.mockResolvedValue(["generate-agents-md"]);

    await run("--data-source-id", "ds-explicit");

    expect(mockQuery).not.toHaveBeenCalled();
    const postCall = postCalls()[0];
    const body = JSON.parse(postCall[1].body);
    expect(body.data_source_id).toBe("ds-explicit");
  });
});

describe("findings loading", () => {
  beforeEach(() => {
    mockQuery.mockResolvedValue([
      { data_source_id: "ds1", provider_slug: "github", name: "o/r", is_indexed: true },
    ]);
  });

  it("exits when findings file missing", async () => {
    mockExistsSync.mockReturnValue(false);
    await expect(run()).rejects.toThrow("exit");
    expect(errorSpy.mock.calls.join(" ")).toContain("Dosu audit");
  });

  it("exits when version is not 1", async () => {
    setFindings({ ...findings, version: 2 });
    await expect(run()).rejects.toThrow("exit");
  });

  it("exits on invalid JSON", async () => {
    mockExistsSync.mockReturnValue(true);
    mockReadFileSync.mockReturnValue("NOT JSON{{{");
    await expect(run()).rejects.toThrow("exit");
  });

  it("exits when findings JSON is valid but null", async () => {
    mockExistsSync.mockReturnValue(true);
    mockReadFileSync.mockReturnValue("null");
    await expect(run()).rejects.toThrow("exit");
  });

  it("exits when findings items is not an array", async () => {
    mockExistsSync.mockReturnValue(true);
    mockReadFileSync.mockReturnValue(JSON.stringify({ version: 1, items: "nope" }));
    await expect(run()).rejects.toThrow("exit");
  });
});

describe("indexing poll (fake timers)", () => {
  const notIndexed = [
    { data_source_id: "ds1", provider_slug: "github", name: "o/r", is_indexed: false },
  ];
  const indexed = [
    { data_source_id: "ds1", provider_slug: "github", name: "o/r", is_indexed: true },
  ];

  beforeEach(() => {
    setFindings(findings);
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("polls through a not-indexed cycle, then proceeds once indexed", async () => {
    mockQuery
      .mockResolvedValueOnce(notIndexed) // initial check in ensureSyncedRepo
      .mockResolvedValueOnce(notIndexed) // poll iteration 1 → sleep
      .mockResolvedValueOnce(indexed); // poll iteration 2 → indexed
    mockFetch
      .mockResolvedValueOnce(jsonResp(capabilities))
      .mockResolvedValueOnce(jsonResp({ task_id: "task-1" }));
    mockMultiselect.mockResolvedValue(["generate-agents-md"]);

    const pr = run();
    await vi.advanceTimersByTimeAsync(6_000);
    await pr;

    expect(mockSpinner.stop).toHaveBeenCalledWith("Repo indexed");
    expect(mockAddPendingTask).toHaveBeenCalled();
  });

  it("exits when indexing never finishes (interactive shows spinner)", async () => {
    mockQuery.mockResolvedValue(notIndexed);
    const assertion = expect(run()).rejects.toThrow("exit");
    await vi.advanceTimersByTimeAsync(130_000);
    await assertion;
    expect(mockSpinner.stop).toHaveBeenCalledWith("Still indexing");
  });

  it("--tasks exits non-interactively when indexing never finishes (no spinner)", async () => {
    mockQuery.mockResolvedValue(notIndexed);
    const assertion = expect(run("--tasks", "generate-agents-md")).rejects.toThrow("exit");
    await vi.advanceTimersByTimeAsync(130_000);
    await assertion;
    expect(mockSpinner.start).not.toHaveBeenCalled(); // quiet poll: no spinner
  });

  it("treats a transient dataSource.list failure during polling as still-indexing", async () => {
    mockQuery
      .mockResolvedValueOnce(notIndexed) // initial check
      .mockRejectedValueOnce(new Error("network blip")); // poll throws → caught
    const assertion = expect(run()).rejects.toThrow("exit");
    await vi.advanceTimersByTimeAsync(3_000);
    await assertion;
    expect(mockSpinner.stop).toHaveBeenCalledWith("Still indexing");
  });

  it("handles a non-Error rejection during polling", async () => {
    mockQuery.mockResolvedValueOnce(notIndexed).mockRejectedValueOnce("string failure"); // non-Error → String(err) branch
    const assertion = expect(run()).rejects.toThrow("exit");
    await vi.advanceTimersByTimeAsync(3_000);
    await assertion;
    expect(mockSpinner.stop).toHaveBeenCalledWith("Still indexing");
  });
});

describe("capability intersection + selection", () => {
  beforeEach(() => {
    mockQuery.mockResolvedValue([
      { data_source_id: "ds1", provider_slug: "github", name: "o/r", is_indexed: true },
    ]);
    setFindings(findings);
  });

  it("only offers items that match a capability", async () => {
    mockFetch.mockResolvedValueOnce(jsonResp(capabilities));
    mockMultiselect.mockResolvedValue([]);
    await run();
    const opts = mockMultiselect.mock.calls[0][0].options as { value: string }[];
    const values = opts.map((o) => o.value);
    expect(values).toContain("generate-agents-md");
    expect(values).toContain("generate-readme");
    expect(values).not.toContain("unsupported-thing");
  });

  it("preselects can_help && action !== skip", async () => {
    mockFetch.mockResolvedValueOnce(jsonResp(capabilities));
    mockMultiselect.mockResolvedValue([]);
    await run();
    const initial = mockMultiselect.mock.calls[0][0].initialValues as string[];
    expect(initial).toEqual(["generate-agents-md"]); // readme is skip
  });

  it("posts correct payload per selected item", async () => {
    mockFetch
      .mockResolvedValueOnce(jsonResp(capabilities))
      .mockResolvedValueOnce(jsonResp({ task_id: "task-1" }));
    mockMultiselect.mockResolvedValue(["generate-agents-md"]);

    await run();

    const postCall = postCalls()[0];
    expect(postCall[0]).toBe("https://api.example.test/v1/cli/task/generate-agents-md");
    expect(postCall[1].headers["X-Dosu-API-Key"]).toBe("sk_user_test");
    const body = JSON.parse(postCall[1].body);
    expect(body.data_source_id).toBe("ds1");
    expect(body.repo).toBe("o/r");
    expect(body.findings.task).toBe("generate-agents-md");
    expect(mockAddPendingTask).toHaveBeenCalledWith({
      task_id: "task-1",
      doc_types: ["agents"],
      repo: "o/r",
    });
  });

  it("--yes selects all can_help && action !== skip without prompting", async () => {
    mockFetch
      .mockResolvedValueOnce(jsonResp(capabilities))
      .mockResolvedValueOnce(jsonResp({ task_id: "task-1" }));

    await run("--yes");

    expect(mockMultiselect).not.toHaveBeenCalled();
    const posts = postCalls();
    expect(posts).toHaveLength(1); // only agents (readme is skip)
    expect(posts[0][0]).toContain("generate-agents-md");
  });

  it("returns early when nothing selected", async () => {
    mockFetch.mockResolvedValueOnce(jsonResp(capabilities));
    mockMultiselect.mockResolvedValue([]);
    await run();
    const posts = postCalls();
    expect(posts).toHaveLength(0);
    expect(mockAddPendingTask).not.toHaveBeenCalled();
  });

  it("handles cancelled multiselect", async () => {
    mockFetch.mockResolvedValueOnce(jsonResp(capabilities));
    mockMultiselect.mockResolvedValue(Symbol("cancel"));
    mockIsCancel.mockReturnValue(true);
    await run();
    const posts = postCalls();
    expect(posts).toHaveLength(0);
  });

  it("info message when no findings intersect capabilities", async () => {
    setFindings({ ...findings, items: [findings.items[2]] }); // only unsupported
    mockFetch.mockResolvedValueOnce(jsonResp(capabilities));
    await run();
    expect(mockMultiselect).not.toHaveBeenCalled();
  });

  it("treats a missing tasks array in the capabilities response as none", async () => {
    mockFetch.mockResolvedValueOnce(jsonResp({})); // no `tasks` key → `?? []`
    await run();
    expect(mockMultiselect).not.toHaveBeenCalled();
  });
});

describe("--tasks (agent-driven, non-interactive)", () => {
  beforeEach(() => {
    mockQuery.mockResolvedValue([
      { data_source_id: "ds1", provider_slug: "github", name: "o/r", is_indexed: true },
    ]);
    setFindings(findings);
  });

  it("fires exactly the requested subset without prompting", async () => {
    mockFetch
      .mockResolvedValueOnce(jsonResp(capabilities))
      .mockResolvedValueOnce(jsonResp({ task_id: "task-1" }));

    await run("--tasks", "generate-agents-md");

    expect(mockMultiselect).not.toHaveBeenCalled();
    const posts = postCalls();
    expect(posts).toHaveLength(1);
    expect(posts[0][0]).toContain("generate-agents-md");
  });

  it("ignores task ids the audit did not offer", async () => {
    mockFetch
      .mockResolvedValueOnce(jsonResp(capabilities))
      .mockResolvedValueOnce(jsonResp({ task_id: "task-1" }));

    await run("--tasks", "generate-agents-md,nope-not-real");

    const posts = postCalls();
    expect(posts).toHaveLength(1);
    expect(posts[0][0]).toContain("generate-agents-md");
  });

  it("never prompts or connects when the repo is unconnected; exits non-zero", async () => {
    mockQuery.mockReset();
    mockQuery.mockResolvedValue([]); // no matching data source
    await expect(run("--tasks", "generate-agents-md")).rejects.toThrow("exit");
    expect(mockConfirm).not.toHaveBeenCalled();
    expect(mockStepConnect).not.toHaveBeenCalled();
  });
});

describe("--json output", () => {
  beforeEach(() => {
    mockQuery.mockResolvedValue([
      { data_source_id: "ds1", provider_slug: "github", name: "o/r", is_indexed: true },
    ]);
    setFindings(findings);
  });

  it("emits task_ids and does NOT poll (non-blocking)", async () => {
    mockFetch
      .mockResolvedValueOnce(jsonResp(capabilities))
      .mockResolvedValueOnce(jsonResp({ task_id: "task-1" }));

    await run("--yes", "--json");

    const out = JSON.parse(logSpy.mock.calls.map((c: unknown[]) => c.join(" ")).join("\n"));
    expect(out.task_ids).toEqual(["task-1"]);
    // No GET /cli/task/run/* call — generation is fire-and-forget.
    const runPolls = fetchCalls().filter((c) => String(c[0]).includes("/cli/task/run/"));
    expect(runPolls).toHaveLength(0);
  });

  it("emits empty task_ids when nothing intersects", async () => {
    setFindings({ ...findings, items: [findings.items[2]] });
    mockFetch.mockResolvedValueOnce(jsonResp(capabilities));
    await run("--json");
    const out = JSON.parse(logSpy.mock.calls.map((c: unknown[]) => c.join(" ")).join("\n"));
    expect(out.task_ids).toEqual([]);
  });
});

describe("error branches", () => {
  beforeEach(() => {
    setFindings(findings);
  });

  it("exits when backend URL is not configured", async () => {
    delete process.env.DOSU_BACKEND_URL_OVERRIDE;
    delete process.env.DOSU_BACKEND_URL;
    mockQuery.mockResolvedValue([
      { data_source_id: "ds1", provider_slug: "github", name: "o/r", is_indexed: true },
    ]);
    await expect(run()).rejects.toThrow("exit");
  });

  it("throws a friendly error when GET /cli/tasks fails", async () => {
    mockQuery.mockResolvedValue([
      { data_source_id: "ds1", provider_slug: "github", name: "o/r", is_indexed: true },
    ]);
    mockFetch.mockResolvedValueOnce(jsonResp({ detail: "capabilities down" }, false));
    await expect(run()).rejects.toThrow("capabilities down");
  });

  it("throws when POST /cli/task fails", async () => {
    mockQuery.mockResolvedValue([
      { data_source_id: "ds1", provider_slug: "github", name: "o/r", is_indexed: true },
    ]);
    mockFetch
      .mockResolvedValueOnce(jsonResp(capabilities))
      .mockResolvedValueOnce(jsonResp({ detail: "task rejected" }, false));
    mockMultiselect.mockResolvedValue(["generate-agents-md"]);
    await expect(run()).rejects.toThrow("task rejected");
  });

  it("falls back to a status message when the error body isn't JSON", async () => {
    mockQuery.mockResolvedValue([
      { data_source_id: "ds1", provider_slug: "github", name: "o/r", is_indexed: true },
    ]);
    mockFetch.mockResolvedValueOnce({
      ok: false,
      status: 503,
      json: async () => {
        throw new Error("not json");
      },
    } as unknown as Response);
    await expect(run()).rejects.toThrow("Request failed with status 503");
  });

  it("uses the status message when the error JSON has no detail field", async () => {
    mockQuery.mockResolvedValue([
      { data_source_id: "ds1", provider_slug: "github", name: "o/r", is_indexed: true },
    ]);
    mockFetch.mockResolvedValueOnce(jsonResp({}, false)); // valid JSON, no `detail`
    await expect(run()).rejects.toThrow("Request failed with status 500");
  });

  it("skips items where the POST returns no task_id", async () => {
    mockQuery.mockResolvedValue([
      { data_source_id: "ds1", provider_slug: "github", name: "o/r", is_indexed: true },
    ]);
    mockFetch.mockResolvedValueOnce(jsonResp(capabilities)).mockResolvedValueOnce(jsonResp({})); // no task_id
    mockMultiselect.mockResolvedValue(["generate-agents-md"]);
    await run();
    expect(mockAddPendingTask).not.toHaveBeenCalled();
  });

  it("exits when connect succeeds but no match appears", async () => {
    mockQuery.mockResolvedValueOnce([]).mockResolvedValueOnce([]); // never matches
    mockConfirm.mockResolvedValue(true);
    mockStepConnect.mockResolvedValue({ has_connected_repo: true });
    await expect(run()).rejects.toThrow("exit");
  });

  it("exits when stepConnect reports no connected repo", async () => {
    mockQuery.mockResolvedValueOnce([]);
    mockConfirm.mockResolvedValue(true);
    mockStepConnect.mockResolvedValue({ has_connected_repo: false });
    await expect(run()).rejects.toThrow("exit");
  });

  it("emits empty task_ids in --json when selection is empty", async () => {
    mockQuery.mockResolvedValue([
      { data_source_id: "ds1", provider_slug: "github", name: "o/r", is_indexed: true },
    ]);
    mockFetch.mockResolvedValueOnce(jsonResp(capabilities));
    mockMultiselect.mockResolvedValue([]);
    await run("--json");
    const out = JSON.parse(logSpy.mock.calls.map((c: unknown[]) => c.join(" ")).join("\n"));
    expect(out.task_ids).toEqual([]);
  });

  it("exits when matched data source has no id after indexing", async () => {
    mockQuery.mockResolvedValue([
      { data_source_id: undefined, provider_slug: "github", name: "o/r", is_indexed: true },
    ]);
    await expect(run()).rejects.toThrow("exit");
  });
});
