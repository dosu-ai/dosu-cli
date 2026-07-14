import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { TypedClient } from "../client/trpc";

// Hoist shared mocks so `vi.mock()` (which runs before imports) can capture them.
const {
  mockOpenDefault,
  mockExecSync,
  mockGetWebAppURL,
  mockPromptGitHubRepositories,
  mockStartInstallationCallbackServer,
  mockTrpc,
} = vi.hoisted(() => ({
  mockOpenDefault: vi.fn().mockResolvedValue(undefined),
  mockExecSync: vi.fn(),
  mockGetWebAppURL: vi.fn(() => "https://app.dosu.dev"),
  mockPromptGitHubRepositories: vi.fn(),
  mockStartInstallationCallbackServer: vi.fn(),
  mockTrpc: {
    githubRepository: { listForOrg: { query: vi.fn() } },
    workspaces: {
      create: { mutate: vi.fn() },
      delete: { mutate: vi.fn() },
      listForSpace: { query: vi.fn() },
    },
    dataSource: {
      create: { mutate: vi.fn() },
      syncDataSource: { mutate: vi.fn() },
      attachToSpace: { mutate: vi.fn() },
      list: { query: vi.fn() },
    },
    deploymentDataSource: { create: { mutate: vi.fn() } },
  },
}));

// The hoisted mock only models the routers this step touches; functions under
// test take the full contract client, so cast once here (standard partial-mock
// pattern in this repo).
const mockTrpcClient = mockTrpc as unknown as TypedClient;

// `open` module — MUST be mocked, or the fallback "open browser" path in
// stepConnectGitHubRepo pops a real GitHub App install tab during tests.
vi.mock("open", () => ({ default: mockOpenDefault }));

// `execSync` — stubbed so `detectGitRepo()` doesn't shell out to real git.
vi.mock("node:child_process", () => ({
  execSync: (...args: unknown[]) => mockExecSync(...args),
}));

vi.mock("@clack/prompts", () => ({
  confirm: vi.fn(),
  multiselect: vi.fn(),
  isCancel: vi.fn(),
  spinner: vi.fn(() => ({ start: vi.fn(), stop: vi.fn() })),
  log: {
    warn: vi.fn(),
    success: vi.fn(),
    error: vi.fn(),
    info: vi.fn(),
    message: vi.fn(),
  },
}));

vi.mock("../debug/logger", () => ({
  logger: {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    init: vi.fn(),
    getLogPath: vi.fn(() => "/tmp/test-debug.log"),
  },
}));

vi.mock("../config/constants", () => ({
  getWebAppURL: mockGetWebAppURL,
}));

// Local installation-callback server — mocked so tests control when / with
// what installation_id the promise resolves.
vi.mock("./installation-server", () => ({
  startInstallationCallbackServer: mockStartInstallationCallbackServer,
}));

vi.mock("./github-repo-prompt", () => ({
  ADD_REPOSITORIES_VALUE: "__add_repositories__",
  REFRESH_LIST_VALUE: "__refresh_list__",
  promptGitHubRepositories: (...args: unknown[]) => mockPromptGitHubRepositories(...args),
}));

// Return our pre-baked mock tRPC client from any call to createTypedClient.
vi.mock("../client/trpc", () => ({
  createTypedClient: vi.fn(() => mockTrpc),
}));

import * as p from "@clack/prompts";
import type { Config } from "../config/config";
import { type FlatTestConfig, makeTestConfig } from "../config/config.test-utils";
import { detectGitRepo, stepConnectGitHubRepo, verifyDataSourcesPersist } from "./github-step";

// Skip the post-connect verify-poll budget so each test resolves in real
// time without needing fake timers to coexist with the install-flow promise
// chain. The verify behaviour itself is still exercised — the loop runs
// once and exits — just without any sleep between checks.
const NO_WAIT_VERIFY = { verify: { timeoutMs: 0, intervalMs: 0 } } as const;
// Same idea for the post-install repo refresh poll: in tests the loop runs
// at most once. Use this when a test wants to exercise the timeout branch
// without burning 10s of real time.
const NO_WAIT_REFRESH = {
  verify: { timeoutMs: 0, intervalMs: 0 },
  refresh: { timeoutMs: 0, intervalMs: 0 },
} as const;

function makeCfg(overrides: Partial<FlatTestConfig> = {}): Config {
  return makeTestConfig({
    access_token: "tok",
    refresh_token: "ref",
    expires_at: Math.floor(Date.now() / 1000) + 3600,
    api_key: "sk_user_x",
    deployment_id: "dep-mcp",
    deployment_name: "Default MCP",
    org_id: "org-1",
    space_id: "space-1",
    ...overrides,
  });
}

describe("detectGitRepo", () => {
  beforeEach(() => {
    mockExecSync.mockReset();
  });

  it("parses SSH URL", () => {
    mockExecSync.mockReturnValue(Buffer.from("git@github.com:acme/api.git\n"));
    expect(detectGitRepo()).toEqual({ owner: "acme", name: "api", slug: "acme/api" });
  });

  it("parses HTTPS URL with trailing slash", () => {
    mockExecSync.mockReturnValue(Buffer.from("https://github.com/acme/api/\n"));
    expect(detectGitRepo()).toEqual({ owner: "acme", name: "api", slug: "acme/api" });
  });

  it("returns null when not in a git repo", () => {
    mockExecSync.mockImplementation(() => {
      throw new Error("not a git repository");
    });
    expect(detectGitRepo()).toBeNull();
  });

  it("returns null for non-GitHub origin", () => {
    mockExecSync.mockReturnValue(Buffer.from("git@gitlab.com:foo/bar.git\n"));
    expect(detectGitRepo()).toBeNull();
  });

  it("returns null when the origin url is empty", () => {
    // git exits 0 with empty stdout when remote.origin.url is unset — covers
    // the `if (!url) return null` guard.
    mockExecSync.mockReturnValue(Buffer.from("   \n"));
    expect(detectGitRepo()).toBeNull();
  });
});

/** Canned installation server — resolves with the given id on demand. */
function installationServerReturning(installationId: number) {
  return {
    server: { port: 54321, close: vi.fn() },
    installationPromise: Promise.resolve({ installation_id: installationId }),
  };
}

describe("stepConnectGitHubRepo", () => {
  beforeEach(() => {
    // resetAllMocks (not clearAllMocks) so leftover `mockResolvedValueOnce`
    // queues from a previous test don't bleed into this one's first call.
    vi.resetAllMocks();
    vi.mocked(p.isCancel).mockReturnValue(false);
    mockPromptGitHubRepositories.mockResolvedValue([]);
    mockStartInstallationCallbackServer.mockResolvedValue(installationServerReturning(12345));
    // Default: dataSource.list returns whatever's in mockTrpc state. Tests
    // that exercise the verify step set their own mock; the rest stub it
    // empty so verifyDataSourcesPersist completes immediately.
    mockTrpc.dataSource.list.query.mockResolvedValue([]);
    mockTrpc.workspaces.delete.mutate.mockResolvedValue({});
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.resetAllMocks();
  });

  it("returns advance=false when cfg has no org_id / space_id", async () => {
    const result = await stepConnectGitHubRepo(
      makeCfg({ org_id: undefined, space_id: undefined }),
      null,
    );
    expect(result.advance).toBe(false);
    expect(mockOpenDefault).not.toHaveBeenCalled();
    expect(mockTrpc.githubRepository.listForOrg.query).not.toHaveBeenCalled();
  });

  it("lets the user skip the browser when an undeployed repo is already visible", async () => {
    mockTrpc.githubRepository.listForOrg.query.mockResolvedValue([
      { repository_id: 1, name: "api", slug: "acme/api", is_deployed: false },
    ]);
    // User picks no repos (empty selection) → returns advance=true immediately.
    const result = await stepConnectGitHubRepo(makeCfg(), {
      owner: "acme",
      name: "api",
      slug: "acme/api",
    });

    expect(mockOpenDefault).not.toHaveBeenCalled();
    expect(result.advance).toBe(true);
    const promptArgs = mockPromptGitHubRepositories.mock.calls[0][0] as {
      options: { label: string; value: string }[];
      initialValues?: string[];
    };
    expect(promptArgs.options).toMatchObject([
      { label: "Add repositories...", value: "__add_repositories__" },
      { label: "Refresh list", value: "__refresh_list__" },
      { kind: "separator" },
      { label: "acme/api", value: "acme/api" },
    ]);
    expect(promptArgs.initialValues).toEqual([]);
  });

  it("refreshes the same repository multiselect after add-repositories is selected", async () => {
    mockTrpc.githubRepository.listForOrg.query
      .mockResolvedValueOnce([
        { repository_id: 1, name: "api", slug: "acme/api", is_deployed: false },
      ])
      .mockResolvedValueOnce([
        { repository_id: 1, name: "api", slug: "acme/api", is_deployed: false },
        { repository_id: 2, name: "core", slug: "acme/core", is_deployed: false },
      ]);
    mockPromptGitHubRepositories
      .mockResolvedValueOnce("__add_repositories__")
      .mockResolvedValueOnce(["acme/core"]);
    mockTrpc.workspaces.create.mutate.mockResolvedValue({ deployment_id: "dep-core" });
    mockTrpc.dataSource.create.mutate.mockResolvedValue({ data_source_id: "ds-core" });
    mockTrpc.workspaces.listForSpace.query.mockResolvedValue([{ deployment_id: "dep-core" }]);
    mockTrpc.dataSource.list.query.mockResolvedValue([
      { data_source_id: "ds-core", provider_slug: "github", is_indexed: false },
    ]);

    const result = await stepConnectGitHubRepo(makeCfg(), null, NO_WAIT_VERIFY);

    expect(mockOpenDefault).toHaveBeenCalledOnce();
    expect(mockPromptGitHubRepositories).toHaveBeenCalledTimes(2);
    expect(mockTrpc.githubRepository.listForOrg.query).toHaveBeenCalledTimes(2);
    const firstArgs = mockPromptGitHubRepositories.mock.calls[0][0] as {
      options: { kind?: string; value?: string }[];
    };
    const secondArgs = mockPromptGitHubRepositories.mock.calls[1][0] as {
      options: { kind?: string; value?: string }[];
    };
    expect(firstArgs.options.filter((o) => o.kind === "repo").map((o) => o.value)).toEqual([
      "acme/api",
    ]);
    expect(secondArgs.options.filter((o) => o.kind === "repo").map((o) => o.value)).toEqual([
      "acme/api",
      "acme/core",
    ]);
    expect(mockTrpc.workspaces.create.mutate).toHaveBeenCalledTimes(1);
    const [args] = mockTrpc.workspaces.create.mutate.mock.calls[0];
    expect(args.name).toBe("acme/core");
    expect(result.advance).toBe(true);
  });

  it("opens the web middle page and refetches after installation callback", async () => {
    // Pre-flight: all already deployed → triggers the install handshake.
    mockTrpc.githubRepository.listForOrg.query
      .mockResolvedValueOnce([
        { repository_id: 1, name: "api", slug: "acme/api", is_deployed: true },
      ])
      // After `/cli/connect-github-done` forwards installation_id back to us,
      // the list now includes an undeployed repo.
      .mockResolvedValueOnce([
        { repository_id: 1, name: "api", slug: "acme/api", is_deployed: true },
        { repository_id: 2, name: "core", slug: "acme/core", is_deployed: false },
      ]);
    mockPromptGitHubRepositories
      .mockResolvedValueOnce("__add_repositories__")
      .mockResolvedValueOnce([]);

    const result = await stepConnectGitHubRepo(makeCfg(), null);

    expect(mockStartInstallationCallbackServer).toHaveBeenCalledOnce();
    expect(mockOpenDefault).toHaveBeenCalledOnce();
    const openedURL = new URL(mockOpenDefault.mock.calls[0]?.[0] as string);
    expect(openedURL.pathname).toBe("/cli/connect-github");
    expect(openedURL.searchParams.get("callback")).toBe("http://localhost:54321/callback");
    // Two listForOrg calls: pre-flight + post-installation refresh.
    expect(mockTrpc.githubRepository.listForOrg.query).toHaveBeenCalledTimes(2);
    expect(result.advance).toBe(true);
  });

  it("waits for a newly visible repository instead of stopping on intermediate removals", async () => {
    mockTrpc.githubRepository.listForOrg.query
      .mockResolvedValueOnce([
        { repository_id: 1, name: "api", slug: "acme/api", is_deployed: false },
        { repository_id: 2, name: "old", slug: "acme/old", is_deployed: false },
      ])
      .mockResolvedValueOnce([
        { repository_id: 1, name: "api", slug: "acme/api", is_deployed: false },
        { repository_id: 2, name: "old", slug: "acme/old", is_deployed: false },
      ])
      .mockResolvedValueOnce([
        { repository_id: 1, name: "api", slug: "acme/api", is_deployed: false },
      ])
      .mockResolvedValueOnce([
        { repository_id: 1, name: "api", slug: "acme/api", is_deployed: false },
        { repository_id: 3, name: "core", slug: "acme/core", is_deployed: false },
      ]);
    mockPromptGitHubRepositories
      .mockResolvedValueOnce("__add_repositories__")
      .mockResolvedValueOnce(["acme/core"]);
    mockTrpc.workspaces.create.mutate.mockResolvedValue({ deployment_id: "dep-core" });
    mockTrpc.dataSource.create.mutate.mockResolvedValue({ data_source_id: "ds-core" });
    mockTrpc.workspaces.listForSpace.query.mockResolvedValue([{ deployment_id: "dep-core" }]);
    mockTrpc.dataSource.list.query.mockResolvedValue([
      { data_source_id: "ds-core", provider_slug: "github", is_indexed: false },
    ]);

    const result = await stepConnectGitHubRepo(
      makeCfg(),
      { owner: "acme", name: "api", slug: "acme/api" },
      NO_WAIT_VERIFY,
    );

    expect(mockTrpc.githubRepository.listForOrg.query).toHaveBeenCalledTimes(4);
    expect(mockPromptGitHubRepositories).toHaveBeenCalledTimes(2);
    const secondArgs = mockPromptGitHubRepositories.mock.calls[1][0] as {
      options: { kind?: string; value?: string }[];
    };
    expect(secondArgs.options.filter((o) => o.kind === "repo").map((o) => o.value)).toEqual([
      "acme/api",
      "acme/core",
    ]);
    expect(mockTrpc.workspaces.create.mutate).toHaveBeenCalledTimes(1);
    const [args] = mockTrpc.workspaces.create.mutate.mock.calls[0];
    expect(args.name).toBe("acme/core");
    expect(result.advance).toBe(true);
  });

  it("returns advance=false when the GitHub install times out", async () => {
    // installationPromise never resolves; with install.timeoutMs = 1, the
    // race resolves to null and the flow bails. Covers the
    // `installationID === null` branch.
    mockTrpc.githubRepository.listForOrg.query.mockResolvedValue([]);
    mockStartInstallationCallbackServer.mockResolvedValue({
      server: { port: 0, close: vi.fn() },
      installationPromise: new Promise<{ installation_id: number }>(() => {}),
    });
    mockPromptGitHubRepositories.mockResolvedValueOnce("__add_repositories__");

    const result = await stepConnectGitHubRepo(makeCfg(), null, {
      verify: { timeoutMs: 0, intervalMs: 0 },
      refresh: { timeoutMs: 0, intervalMs: 0 },
      install: { timeoutMs: 1 },
    });

    expect(result.advance).toBe(false);
    expect(p.log.warn).toHaveBeenCalledWith(
      expect.stringContaining("Didn't hear back from the browser"),
    );
  });

  it("warns when add-repositories install completes but no new repo appears", async () => {
    // Same repo list before and after install — backend still syncing, polling
    // budget elapses without seeing a new repo. We expect a warn pointing the
    // user at "Refresh list" to retry.
    mockTrpc.githubRepository.listForOrg.query.mockResolvedValue([
      { repository_id: 1, name: "api", slug: "acme/api", is_deployed: false },
    ]);
    mockPromptGitHubRepositories
      .mockResolvedValueOnce("__add_repositories__")
      .mockResolvedValueOnce([]);

    const result = await stepConnectGitHubRepo(makeCfg(), null, NO_WAIT_REFRESH);

    expect(mockOpenDefault).toHaveBeenCalledOnce();
    expect(p.log.warn).toHaveBeenCalledWith(expect.stringContaining("GitHub may still be syncing"));
    expect(p.log.warn).toHaveBeenCalledWith(expect.stringContaining("Refresh list"));
    expect(result.advance).toBe(true);
  });

  it("refreshes the list without opening the browser when refresh-list is selected", async () => {
    // First listForOrg = pre-flight (1 repo). User picks "Refresh list" → second
    // listForOrg returns 2 repos. User then picks the new one.
    mockTrpc.githubRepository.listForOrg.query
      .mockResolvedValueOnce([
        { repository_id: 1, name: "api", slug: "acme/api", is_deployed: false },
      ])
      .mockResolvedValueOnce([
        { repository_id: 1, name: "api", slug: "acme/api", is_deployed: false },
        { repository_id: 2, name: "core", slug: "acme/core", is_deployed: false },
      ]);
    mockPromptGitHubRepositories
      .mockResolvedValueOnce("__refresh_list__")
      .mockResolvedValueOnce(["acme/core"]);
    mockTrpc.workspaces.create.mutate.mockResolvedValue({ deployment_id: "dep-core" });
    mockTrpc.dataSource.create.mutate.mockResolvedValue({ data_source_id: "ds-core" });
    mockTrpc.workspaces.listForSpace.query.mockResolvedValue([{ deployment_id: "dep-core" }]);
    mockTrpc.dataSource.list.query.mockResolvedValue([
      { data_source_id: "ds-core", provider_slug: "github", is_indexed: false },
    ]);

    const result = await stepConnectGitHubRepo(makeCfg(), null, NO_WAIT_VERIFY);

    expect(mockOpenDefault).not.toHaveBeenCalled();
    expect(mockStartInstallationCallbackServer).not.toHaveBeenCalled();
    expect(mockTrpc.githubRepository.listForOrg.query).toHaveBeenCalledTimes(2);
    expect(mockPromptGitHubRepositories).toHaveBeenCalledTimes(2);
    const secondArgs = mockPromptGitHubRepositories.mock.calls[1][0] as {
      options: { kind?: string; value?: string }[];
    };
    expect(secondArgs.options.filter((o) => o.kind === "repo").map((o) => o.value)).toEqual([
      "acme/api",
      "acme/core",
    ]);
    expect(result.advance).toBe(true);
  });

  it("reports the count when refresh-list finds multiple new repos (plural label)", async () => {
    // Covers the `newCount === 1 ? "" : "s"` plural branch in the refresh
    // spinner.stop label.
    mockTrpc.githubRepository.listForOrg.query
      .mockResolvedValueOnce([
        { repository_id: 1, name: "api", slug: "acme/api", is_deployed: false },
      ])
      .mockResolvedValueOnce([
        { repository_id: 1, name: "api", slug: "acme/api", is_deployed: false },
        { repository_id: 2, name: "core", slug: "acme/core", is_deployed: false },
        { repository_id: 3, name: "web", slug: "acme/web", is_deployed: false },
      ]);
    mockPromptGitHubRepositories
      .mockResolvedValueOnce("__refresh_list__")
      .mockResolvedValueOnce([]);

    const result = await stepConnectGitHubRepo(makeCfg(), null, NO_WAIT_VERIFY);

    expect(mockTrpc.githubRepository.listForOrg.query).toHaveBeenCalledTimes(2);
    expect(result.advance).toBe(true);
  });

  it("falls back to previous repos when polling returns an empty list", async () => {
    // Covers the `polledRepos.length === 0 && previousRepos.length > 0` ternary
    // in waitForRepositoryRefresh — a transient empty response shouldn't wipe
    // the in-memory list before the next prompt.
    mockTrpc.githubRepository.listForOrg.query
      .mockResolvedValueOnce([
        { repository_id: 1, name: "api", slug: "acme/api", is_deployed: false },
      ])
      .mockResolvedValueOnce([]);
    mockPromptGitHubRepositories
      .mockResolvedValueOnce("__add_repositories__")
      .mockResolvedValueOnce([]);

    const result = await stepConnectGitHubRepo(makeCfg(), null, NO_WAIT_REFRESH);

    // Second call to the prompt should still see the original repo because the
    // empty polled response was discarded.
    const secondArgs = mockPromptGitHubRepositories.mock.calls[1][0] as {
      options: { kind?: string; value?: string }[];
    };
    expect(secondArgs.options.filter((o) => o.kind === "repo").map((o) => o.value)).toEqual([
      "acme/api",
    ]);
    expect(result.advance).toBe(true);
  });

  it("reports zero new repos when refresh-list finds nothing fresh", async () => {
    // Same list pre-flight and post-refresh — covers the "List refreshed — no
    // new repos yet" branch and the empty-selection exit.
    mockTrpc.githubRepository.listForOrg.query.mockResolvedValue([
      { repository_id: 1, name: "api", slug: "acme/api", is_deployed: false },
    ]);
    mockPromptGitHubRepositories
      .mockResolvedValueOnce("__refresh_list__")
      .mockResolvedValueOnce([]);

    const result = await stepConnectGitHubRepo(makeCfg(), null, NO_WAIT_VERIFY);

    expect(mockOpenDefault).not.toHaveBeenCalled();
    expect(mockTrpc.githubRepository.listForOrg.query).toHaveBeenCalledTimes(2);
    expect(result.advance).toBe(true);
  });

  it("creates deployment + data_source + link for each selected repo", async () => {
    mockTrpc.githubRepository.listForOrg.query.mockResolvedValue([
      { repository_id: 100, name: "api", slug: "acme/api", is_deployed: false },
      { repository_id: 200, name: "web", slug: "acme/web", is_deployed: false },
    ]);
    mockPromptGitHubRepositories.mockResolvedValue(["acme/api", "acme/web"]);
    mockTrpc.workspaces.create.mutate
      .mockResolvedValueOnce({ deployment_id: "dep-A" })
      .mockResolvedValueOnce({ deployment_id: "dep-B" });
    mockTrpc.dataSource.create.mutate
      .mockResolvedValueOnce({ data_source_id: "ds-A" })
      .mockResolvedValueOnce({ data_source_id: "ds-B" });
    mockTrpc.workspaces.listForSpace.query.mockResolvedValue([
      { deployment_id: "dep-mcp" },
      { deployment_id: "dep-A" },
      { deployment_id: "dep-B" },
    ]);
    mockTrpc.deploymentDataSource.create.mutate.mockResolvedValue({});
    mockTrpc.dataSource.list.query.mockResolvedValue([
      { data_source_id: "ds-A", provider_slug: "github", is_indexed: false },
      { data_source_id: "ds-B", provider_slug: "github", is_indexed: false },
    ]);

    const result = await stepConnectGitHubRepo(
      makeCfg(),
      { owner: "acme", name: "api", slug: "acme/api" },
      NO_WAIT_VERIFY,
    );

    expect(result.advance).toBe(true);
    expect(mockTrpc.workspaces.create.mutate).toHaveBeenCalledTimes(2);
    expect(mockTrpc.dataSource.create.mutate).toHaveBeenCalledTimes(2);
    // syncDataSource fires once per created data source so the backend
    // enqueues `sync_data_source` and clones the repo.
    expect(mockTrpc.dataSource.syncDataSource.mutate).toHaveBeenCalledTimes(2);
    expect(mockTrpc.dataSource.syncDataSource.mutate).toHaveBeenCalledWith({
      data_source_id: "ds-A",
    });
    expect(mockTrpc.dataSource.syncDataSource.mutate).toHaveBeenCalledWith({
      data_source_id: "ds-B",
    });
    expect(mockTrpc.dataSource.attachToSpace.mutate).toHaveBeenCalledTimes(2);
    expect(mockTrpc.dataSource.attachToSpace.mutate).toHaveBeenCalledWith({
      space_id: "space-1",
      data_source_ids: ["ds-A"],
    });
    expect(mockTrpc.dataSource.attachToSpace.mutate).toHaveBeenCalledWith({
      space_id: "space-1",
      data_source_ids: ["ds-B"],
    });
    // deploymentDataSource.create fires once per (selected repo × space deployments):
    // 2 repos × 3 deployments = 6 invocations.
    expect(mockTrpc.deploymentDataSource.create.mutate).toHaveBeenCalledTimes(6);
    // Cwd repo's deployment is reported as primary.
    expect(result.deployment_id).toBe("dep-A");
    expect(result.space_id).toBe("space-1");
    // Both data_sources survived the verify step — neither got deleted by
    // backend sync — so they're surfaced for downstream doc-import wait.
    expect(result.created_data_source_ids).toEqual(["ds-A", "ds-B"]);
    expect(mockTrpc.workspaces.delete.mutate).not.toHaveBeenCalled();
  });

  it("shows already-deployed repos in a separate info block, excludes them from multiselect", async () => {
    mockTrpc.githubRepository.listForOrg.query.mockResolvedValue([
      { repository_id: 1, name: "api", slug: "acme/api", is_deployed: true },
      { repository_id: 2, name: "core", slug: "acme/core", is_deployed: false },
      { repository_id: 3, name: "web", slug: "acme/web", is_deployed: true },
      { repository_id: 4, name: "cli", slug: "acme/cli", is_deployed: false },
    ]);
    mockPromptGitHubRepositories.mockResolvedValue(["acme/core"]);
    mockTrpc.workspaces.create.mutate.mockResolvedValue({ deployment_id: "dep-X" });
    mockTrpc.dataSource.create.mutate.mockResolvedValue({ data_source_id: "ds-X" });
    mockTrpc.workspaces.listForSpace.query.mockResolvedValue([{ deployment_id: "dep-X" }]);
    mockTrpc.dataSource.list.query.mockResolvedValue([
      { data_source_id: "ds-X", provider_slug: "github", is_indexed: false },
    ]);

    await stepConnectGitHubRepo(makeCfg(), null, NO_WAIT_VERIFY);

    // Multiselect only contains undeployed repos — deployed ones can't be
    // navigated to because they're not in the options list at all.
    const multiselectArgs = mockPromptGitHubRepositories.mock.calls[0][0] as {
      options: { kind?: string; value?: string }[];
    };
    expect(multiselectArgs.options.filter((o) => o.kind === "repo").map((o) => o.value)).toEqual([
      "acme/core",
      "acme/cli",
    ]);
    // Deployed repos surface via a separate info log.
    const infoCalls = vi.mocked(p.log.info).mock.calls.map((c) => String(c[0]));
    expect(infoCalls.some((s) => s.includes("Already connected") && s.includes("acme/api"))).toBe(
      true,
    );
    // Only the selected undeployed repo gets created.
    expect(mockTrpc.workspaces.create.mutate).toHaveBeenCalledTimes(1);
    const [args] = mockTrpc.workspaces.create.mutate.mock.calls[0];
    expect(args.name).toBe("acme/core");
  });

  it("advances silently when every repo is already deployed", async () => {
    mockTrpc.githubRepository.listForOrg.query.mockResolvedValue([
      { repository_id: 1, name: "api", slug: "acme/api", is_deployed: true },
    ]);
    mockPromptGitHubRepositories.mockResolvedValue([]);

    const result = await stepConnectGitHubRepo(makeCfg(), null);

    expect(result.advance).toBe(true);
    expect(mockPromptGitHubRepositories).toHaveBeenCalledOnce();
    expect(mockTrpc.workspaces.create.mutate).not.toHaveBeenCalled();
  });

  it("returns advance=true when no selection (all already deployed)", async () => {
    mockTrpc.githubRepository.listForOrg.query.mockResolvedValue([
      { repository_id: 1, name: "api", slug: "acme/api", is_deployed: false },
    ]);
    mockPromptGitHubRepositories.mockResolvedValue([]); // user picks nothing

    const result = await stepConnectGitHubRepo(makeCfg(), null);

    // No creations fired, but step advances because we don't want to
    // re-prompt if the user consciously declined to pick anything.
    expect(result.advance).toBe(true);
    expect(mockTrpc.workspaces.create.mutate).not.toHaveBeenCalled();
  });

  it("reverts orphan deployment when backend deletes its data_source mid-sync", async () => {
    // Reproduces the staging case: `dataSource.create` succeeds, but
    // `sync_github_data_source` fires `RepositoryNotFoundException` because
    // Dosu's GitHub App can't reach the repo, so the backend deletes the
    // data_source row a few seconds later. The CLI must detect that and
    // tear down the orphan deployment instead of reporting "Connected".
    mockTrpc.githubRepository.listForOrg.query.mockResolvedValue([
      { repository_id: 100, name: "good", slug: "acme/good", is_deployed: false },
      { repository_id: 200, name: "stale", slug: "acme/stale", is_deployed: false },
    ]);
    mockPromptGitHubRepositories.mockResolvedValue(["acme/good", "acme/stale"]);
    mockTrpc.workspaces.create.mutate
      .mockResolvedValueOnce({ deployment_id: "dep-good" })
      .mockResolvedValueOnce({ deployment_id: "dep-stale" });
    mockTrpc.dataSource.create.mutate
      .mockResolvedValueOnce({ data_source_id: "ds-good" })
      .mockResolvedValueOnce({ data_source_id: "ds-stale" });
    mockTrpc.workspaces.listForSpace.query.mockResolvedValue([
      { deployment_id: "dep-good" },
      { deployment_id: "dep-stale" },
    ]);
    mockTrpc.deploymentDataSource.create.mutate.mockResolvedValue({});
    // Verify-poll sees ds-good present and ds-stale missing (backend already
    // deleted it after RepositoryNotFoundException) — single-iteration mock
    // is sufficient because NO_WAIT_VERIFY exits as soon as a drop appears.
    mockTrpc.dataSource.list.query.mockResolvedValue([
      { data_source_id: "ds-good", provider_slug: "github", is_indexed: false },
    ]);

    const result = await stepConnectGitHubRepo(makeCfg(), null, NO_WAIT_VERIFY);

    expect(result.advance).toBe(true);
    expect(mockTrpc.workspaces.delete.mutate).toHaveBeenCalledTimes(1);
    expect(mockTrpc.workspaces.delete.mutate).toHaveBeenCalledWith("dep-stale");
    expect(result.created_data_source_ids).toEqual(["ds-good"]);
    expect(result.deployment_id).toBe("dep-good");
    const warnCalls = vi.mocked(p.log.warn).mock.calls.map((c) => String(c[0]));
    expect(warnCalls.some((m) => m.includes("acme/stale"))).toBe(true);
  });

  it("rolls back the deployment when dataSource.create returns nothing", async () => {
    // dataSource.create occasionally returns null on the staging tRPC router
    // (transient validation failure). Without rollback the deployment row
    // would be left orphaned and reported as Connected, then leak into
    // cfg.deployment_id as primary on first-run onboarding.
    mockTrpc.githubRepository.listForOrg.query.mockResolvedValue([
      { repository_id: 1, name: "good", slug: "acme/good", is_deployed: false },
      { repository_id: 2, name: "broken", slug: "acme/broken", is_deployed: false },
    ]);
    mockPromptGitHubRepositories.mockResolvedValue(["acme/good", "acme/broken"]);
    mockTrpc.workspaces.create.mutate
      .mockResolvedValueOnce({ deployment_id: "dep-good" })
      .mockResolvedValueOnce({ deployment_id: "dep-broken" });
    mockTrpc.dataSource.create.mutate
      .mockResolvedValueOnce({ data_source_id: "ds-good" })
      .mockResolvedValueOnce(null);
    mockTrpc.workspaces.listForSpace.query.mockResolvedValue([{ deployment_id: "dep-good" }]);
    mockTrpc.deploymentDataSource.create.mutate.mockResolvedValue({});
    mockTrpc.dataSource.list.query.mockResolvedValue([
      { data_source_id: "ds-good", provider_slug: "github", is_indexed: false },
    ]);

    const result = await stepConnectGitHubRepo(makeCfg(), null, NO_WAIT_VERIFY);

    expect(result.advance).toBe(true);
    expect(result.deployment_id).toBe("dep-good");
    expect(result.created_data_source_ids).toEqual(["ds-good"]);
    expect(mockTrpc.workspaces.delete.mutate).toHaveBeenCalledWith("dep-broken");
    expect(mockTrpc.workspaces.delete.mutate).not.toHaveBeenCalledWith("dep-good");
  });

  it("fails the step when every connected data_source gets deleted by backend sync", async () => {
    mockTrpc.githubRepository.listForOrg.query.mockResolvedValue([
      { repository_id: 100, name: "stale", slug: "acme/stale", is_deployed: false },
    ]);
    mockPromptGitHubRepositories.mockResolvedValue(["acme/stale"]);
    mockTrpc.workspaces.create.mutate.mockResolvedValue({ deployment_id: "dep-stale" });
    mockTrpc.dataSource.create.mutate.mockResolvedValue({ data_source_id: "ds-stale" });
    mockTrpc.workspaces.listForSpace.query.mockResolvedValue([{ deployment_id: "dep-stale" }]);
    mockTrpc.dataSource.list.query.mockResolvedValue([]); // already gone

    const result = await stepConnectGitHubRepo(makeCfg(), null, NO_WAIT_VERIFY);

    expect(result.advance).toBe(false);
    expect(mockTrpc.workspaces.delete.mutate).toHaveBeenCalledWith("dep-stale");
    const errorCalls = vi.mocked(p.log.error).mock.calls.map((c) => String(c[0]));
    expect(errorCalls.some((m) => m.includes("acme/stale"))).toBe(true);
  });

  it("sorts repos most-recently-added-first so a fresh GitHub App install lands on top", async () => {
    // Backend sorts alphabetically; for orgs with hundreds of repos that
    // buries the one the user just added. The CLI re-sorts by created_at
    // desc so the freshly installed repo is the first thing the cursor
    // can reach.
    mockTrpc.githubRepository.listForOrg.query.mockResolvedValue([
      {
        repository_id: 1,
        name: "old",
        slug: "acme/old",
        is_deployed: false,
        created_at: "2025-01-01T00:00:00Z",
      },
      {
        repository_id: 2,
        name: "newest",
        slug: "acme/newest",
        is_deployed: false,
        created_at: "2026-04-27T18:00:00Z",
      },
      {
        repository_id: 3,
        name: "middle",
        slug: "acme/middle",
        is_deployed: false,
        created_at: "2025-12-01T00:00:00Z",
      },
    ]);
    mockPromptGitHubRepositories.mockResolvedValue([]);

    await stepConnectGitHubRepo(makeCfg(), null, NO_WAIT_VERIFY);

    const args = mockPromptGitHubRepositories.mock.calls[0][0] as {
      options: { kind?: string; value?: string }[];
    };
    expect(args.options.filter((o) => o.kind === "repo").map((o) => o.value)).toEqual([
      "acme/newest",
      "acme/middle",
      "acme/old",
    ]);
  });

  it("keeps the prior repo list when a post-install poll returns empty", async () => {
    // A non-zero refresh budget lets the poll loop body run. The poll returns
    // an empty list while the previous list was non-empty, so the
    // `polledRepos.length === 0 && previousRepos.length > 0` ternary keeps the
    // previous repos rather than wiping them.
    mockTrpc.githubRepository.listForOrg.query
      .mockResolvedValueOnce([
        { repository_id: 1, name: "api", slug: "acme/api", is_deployed: false },
      ])
      .mockResolvedValue([]); // every poll comes back empty
    mockPromptGitHubRepositories
      .mockResolvedValueOnce("__add_repositories__")
      .mockResolvedValueOnce([]);

    const result = await stepConnectGitHubRepo(makeCfg(), null, {
      verify: { timeoutMs: 0, intervalMs: 0 },
      refresh: { timeoutMs: 5, intervalMs: 0 },
    });

    // Second prompt still shows the original repo — the empty poll was ignored.
    const secondArgs = mockPromptGitHubRepositories.mock.calls[1][0] as {
      options: { kind?: string; value?: string }[];
    };
    expect(secondArgs.options.filter((o) => o.kind === "repo").map((o) => o.value)).toEqual([
      "acme/api",
    ]);
    expect(result.advance).toBe(true);
  });

  it("treats listForOrg failures as an empty list (catch path)", async () => {
    // The pre-flight `fetchListForOrg` swallows errors and returns []. With no
    // repos and an empty selection the step advances. Covers the catch block
    // in fetchListForOrg.
    mockTrpc.githubRepository.listForOrg.query.mockRejectedValue(new Error("network down"));
    mockPromptGitHubRepositories.mockResolvedValue([]);

    const result = await stepConnectGitHubRepo(makeCfg(), null);

    expect(result.advance).toBe(true);
    expect(mockTrpc.workspaces.create.mutate).not.toHaveBeenCalled();
  });

  it("treats a non-Error listForOrg rejection as an empty list", async () => {
    // A bare string rejection exercises the `String(err)` side of the catch's
    // `instanceof Error` ternary in fetchListForOrg.
    mockTrpc.githubRepository.listForOrg.query.mockRejectedValue("offline");
    mockPromptGitHubRepositories.mockResolvedValue([]);

    const result = await stepConnectGitHubRepo(makeCfg(), null);

    expect(result.advance).toBe(true);
  });

  it("falls back to a manual URL message when the browser fails to open", async () => {
    // `open` throwing should not abort the install flow — it logs a manual URL
    // and keeps waiting for the callback. Covers the openGitHubInstallFlow
    // open-failure catch block.
    mockTrpc.githubRepository.listForOrg.query.mockResolvedValue([
      { repository_id: 1, name: "api", slug: "acme/api", is_deployed: false },
    ]);
    mockOpenDefault.mockRejectedValueOnce(new Error("no browser"));
    mockPromptGitHubRepositories
      .mockResolvedValueOnce("__add_repositories__")
      .mockResolvedValueOnce([]);

    const result = await stepConnectGitHubRepo(makeCfg(), null, NO_WAIT_REFRESH);

    const infoCalls = vi.mocked(p.log.info).mock.calls.map((c) => String(c[0]));
    expect(infoCalls.some((s) => s.includes("Could not open browser"))).toBe(true);
    expect(result.advance).toBe(true);
  });

  it("falls back to a manual URL message when open rejects with a non-Error", async () => {
    // A non-Error rejection from `open` takes the `String(err)` branch of the
    // open-failure catch ternary.
    mockTrpc.githubRepository.listForOrg.query.mockResolvedValue([
      { repository_id: 1, name: "api", slug: "acme/api", is_deployed: false },
    ]);
    mockOpenDefault.mockRejectedValueOnce("spawn EACCES");
    mockPromptGitHubRepositories
      .mockResolvedValueOnce("__add_repositories__")
      .mockResolvedValueOnce([]);

    const result = await stepConnectGitHubRepo(makeCfg(), null, NO_WAIT_REFRESH);

    const infoCalls = vi.mocked(p.log.info).mock.calls.map((c) => String(c[0]));
    expect(infoCalls.some((s) => s.includes("Could not open browser"))).toBe(true);
    expect(result.advance).toBe(true);
  });

  it("rolls back when workspaces.create returns no deployment_id", async () => {
    // A null/empty deployment from workspaces.create must short-circuit
    // createDeploymentForRepo without creating a data_source. With the only
    // selected repo failing, `created` is empty so the step reports failure.
    mockTrpc.githubRepository.listForOrg.query.mockResolvedValue([
      { repository_id: 1, name: "api", slug: "acme/api", is_deployed: false },
    ]);
    mockPromptGitHubRepositories.mockResolvedValue(["acme/api"]);
    mockTrpc.workspaces.create.mutate.mockResolvedValue(null);

    const result = await stepConnectGitHubRepo(makeCfg(), null, NO_WAIT_VERIFY);

    expect(result.advance).toBe(false);
    expect(mockTrpc.dataSource.create.mutate).not.toHaveBeenCalled();
    const warnCalls = vi.mocked(p.log.warn).mock.calls.map((c) => String(c[0]));
    expect(warnCalls.some((m) => m.includes("Could not connect any repos"))).toBe(false);
  });

  it("swallows tRPC errors mid-wireup and reports the repo as failed", async () => {
    // A throw from any mutate inside createDeploymentForRepo (here:
    // syncDataSource) is caught and logged, yielding null for that repo.
    // With the only repo failing, `created` is empty → no survivors → failure.
    mockTrpc.githubRepository.listForOrg.query.mockResolvedValue([
      { repository_id: 1, name: "api", slug: "acme/api", is_deployed: false },
    ]);
    mockPromptGitHubRepositories.mockResolvedValue(["acme/api"]);
    mockTrpc.workspaces.create.mutate.mockResolvedValue({ deployment_id: "dep-api" });
    mockTrpc.dataSource.create.mutate.mockResolvedValue({ data_source_id: "ds-api" });
    mockTrpc.dataSource.syncDataSource.mutate.mockRejectedValue(new Error("trpc 500"));

    const result = await stepConnectGitHubRepo(makeCfg(), null, NO_WAIT_VERIFY);

    expect(result.advance).toBe(false);
    const errorCalls = vi.mocked(p.log.error).mock.calls.map((c) => String(c[0]));
    expect(errorCalls.some((m) => m.includes("Could not connect any repos"))).toBe(true);
  });

  it("swallows a non-Error tRPC rejection mid-wireup", async () => {
    // A non-Error rejection from a mutate inside createDeploymentForRepo takes
    // the `String(err)` side of that catch's `instanceof Error` ternary.
    mockTrpc.githubRepository.listForOrg.query.mockResolvedValue([
      { repository_id: 1, name: "api", slug: "acme/api", is_deployed: false },
    ]);
    mockPromptGitHubRepositories.mockResolvedValue(["acme/api"]);
    mockTrpc.workspaces.create.mutate.mockResolvedValue({ deployment_id: "dep-api" });
    mockTrpc.dataSource.create.mutate.mockResolvedValue({ data_source_id: "ds-api" });
    mockTrpc.dataSource.syncDataSource.mutate.mockRejectedValue("trpc exploded");

    const result = await stepConnectGitHubRepo(makeCfg(), null, NO_WAIT_VERIFY);

    expect(result.advance).toBe(false);
  });

  it("tolerates an orphan-deployment delete that throws (Error)", async () => {
    // The single connected repo is dropped by backend sync, triggering an
    // orphan delete. `workspaces.delete.mutate` rejecting must be swallowed
    // (best-effort cleanup) — covers the deleteOrphanDeployment catch.
    mockTrpc.githubRepository.listForOrg.query.mockResolvedValue([
      { repository_id: 1, name: "stale", slug: "acme/stale", is_deployed: false },
    ]);
    mockPromptGitHubRepositories.mockResolvedValue(["acme/stale"]);
    mockTrpc.workspaces.create.mutate.mockResolvedValue({ deployment_id: "dep-stale" });
    mockTrpc.dataSource.create.mutate.mockResolvedValue({ data_source_id: "ds-stale" });
    mockTrpc.workspaces.listForSpace.query.mockResolvedValue([{ deployment_id: "dep-stale" }]);
    mockTrpc.dataSource.list.query.mockResolvedValue([]); // already GC'd
    mockTrpc.workspaces.delete.mutate.mockRejectedValue(new Error("delete failed"));

    const result = await stepConnectGitHubRepo(makeCfg(), null, NO_WAIT_VERIFY);

    expect(result.advance).toBe(false);
    expect(mockTrpc.workspaces.delete.mutate).toHaveBeenCalledWith("dep-stale");
  });

  it("tolerates an orphan-deployment delete that throws (non-Error)", async () => {
    // Same path, but the delete rejects with a bare string — takes the
    // `String(err)` side of the deleteOrphanDeployment catch ternary.
    mockTrpc.githubRepository.listForOrg.query.mockResolvedValue([
      { repository_id: 1, name: "stale", slug: "acme/stale", is_deployed: false },
    ]);
    mockPromptGitHubRepositories.mockResolvedValue(["acme/stale"]);
    mockTrpc.workspaces.create.mutate.mockResolvedValue({ deployment_id: "dep-stale" });
    mockTrpc.dataSource.create.mutate.mockResolvedValue({ data_source_id: "ds-stale" });
    mockTrpc.workspaces.listForSpace.query.mockResolvedValue([{ deployment_id: "dep-stale" }]);
    mockTrpc.dataSource.list.query.mockResolvedValue([]); // already GC'd
    mockTrpc.workspaces.delete.mutate.mockRejectedValue("delete blew up");

    const result = await stepConnectGitHubRepo(makeCfg(), null, NO_WAIT_VERIFY);

    expect(result.advance).toBe(false);
    expect(mockTrpc.workspaces.delete.mutate).toHaveBeenCalledWith("dep-stale");
  });

  it("skips selected slugs that are no longer in the repo list", async () => {
    // The prompt returns a slug that's vanished from `repos` (e.g. removed
    // between prompt render and selection). `repos.find` misses → `continue`.
    // Nothing gets created, so the step fails with the no-reverts error.
    mockTrpc.githubRepository.listForOrg.query.mockResolvedValue([
      { repository_id: 1, name: "api", slug: "acme/api", is_deployed: false },
    ]);
    mockPromptGitHubRepositories.mockResolvedValue(["acme/ghost"]);

    const result = await stepConnectGitHubRepo(makeCfg(), null, NO_WAIT_VERIFY);

    expect(result.advance).toBe(false);
    expect(mockTrpc.workspaces.create.mutate).not.toHaveBeenCalled();
    const errorCalls = vi.mocked(p.log.error).mock.calls.map((c) => String(c[0]));
    expect(errorCalls.some((m) => m.includes("Could not connect any repos"))).toBe(true);
  });

  it("reports skipped + connected counts when some repos survive and others are reverted", async () => {
    // Two survive, two are reverted → exercises the plural `repo${...}s`
    // branches in both the spinner "· N skipped" stop label and the warn line,
    // and the `reverted.length > 0` summary branch.
    mockTrpc.githubRepository.listForOrg.query.mockResolvedValue([
      { repository_id: 1, name: "a", slug: "acme/a", is_deployed: false },
      { repository_id: 2, name: "b", slug: "acme/b", is_deployed: false },
      { repository_id: 3, name: "c", slug: "acme/c", is_deployed: false },
      { repository_id: 4, name: "d", slug: "acme/d", is_deployed: false },
    ]);
    mockPromptGitHubRepositories.mockResolvedValue(["acme/a", "acme/b", "acme/c", "acme/d"]);
    mockTrpc.workspaces.create.mutate
      .mockResolvedValueOnce({ deployment_id: "dep-a" })
      .mockResolvedValueOnce({ deployment_id: "dep-b" })
      .mockResolvedValueOnce({ deployment_id: "dep-c" })
      .mockResolvedValueOnce({ deployment_id: "dep-d" });
    mockTrpc.dataSource.create.mutate
      .mockResolvedValueOnce({ data_source_id: "ds-a" })
      .mockResolvedValueOnce({ data_source_id: "ds-b" })
      .mockResolvedValueOnce({ data_source_id: "ds-c" })
      .mockResolvedValueOnce({ data_source_id: "ds-d" });
    mockTrpc.workspaces.listForSpace.query.mockResolvedValue([{ deployment_id: "dep-a" }]);
    mockTrpc.deploymentDataSource.create.mutate.mockResolvedValue({});
    // ds-a and ds-b survive; ds-c and ds-d were GC'd by the backend.
    mockTrpc.dataSource.list.query.mockResolvedValue([
      { data_source_id: "ds-a", provider_slug: "github", is_indexed: false },
      { data_source_id: "ds-b", provider_slug: "github", is_indexed: false },
    ]);

    const result = await stepConnectGitHubRepo(makeCfg(), null, NO_WAIT_VERIFY);

    expect(result.advance).toBe(true);
    expect(result.created_data_source_ids).toEqual(["ds-a", "ds-b"]);
    expect(mockTrpc.workspaces.delete.mutate).toHaveBeenCalledWith("dep-c");
    expect(mockTrpc.workspaces.delete.mutate).toHaveBeenCalledWith("dep-d");
    const warnCalls = vi.mocked(p.log.warn).mock.calls.map((c) => String(c[0]));
    expect(warnCalls.some((m) => m.includes("acme/c") && m.includes("acme/d"))).toBe(true);
  });

  it("returns advance=false when user cancels the multiselect", async () => {
    mockTrpc.githubRepository.listForOrg.query.mockResolvedValue([
      { repository_id: 1, name: "api", slug: "acme/api", is_deployed: false },
    ]);
    const cancelSymbol = Symbol("cancel");
    mockPromptGitHubRepositories.mockResolvedValue(cancelSymbol as unknown as string[]);
    vi.mocked(p.isCancel).mockImplementation((v) => v === cancelSymbol);

    const result = await stepConnectGitHubRepo(makeCfg(), null);

    expect(result.advance).toBe(false);
    expect(mockTrpc.workspaces.create.mutate).not.toHaveBeenCalled();
  });
});

describe("verifyDataSourcesPersist", () => {
  beforeEach(() => {
    vi.resetAllMocks();
  });

  it("short-circuits with empty sets when there are no expected ids", async () => {
    // Empty expected set never touches the network — covers the early return.
    const result = await verifyDataSourcesPersist(mockTrpcClient, "org-1", []);

    expect(result.alive.size).toBe(0);
    expect(result.dropped.size).toBe(0);
    expect(mockTrpc.dataSource.list.query).not.toHaveBeenCalled();
  });

  it("uses the default poll budget and exits on the first dropped id", async () => {
    // No opts → exercises the `timeoutMs ??` / `intervalMs ??` default
    // branches. A drop on the first poll triggers the `dropped.size > 0` early
    // return, so the real 10s default budget is never actually waited on.
    mockTrpc.dataSource.list.query.mockResolvedValue([{ data_source_id: "ds-1" }]);

    const result = await verifyDataSourcesPersist(mockTrpcClient, "org-1", ["ds-1", "ds-2"]);

    expect([...result.alive]).toEqual(["ds-1"]);
    expect([...result.dropped]).toEqual(["ds-2"]);
    expect(mockTrpc.dataSource.list.query).toHaveBeenCalledTimes(1);
  });

  it("reports dropped ids and exits on the first poll that misses one", async () => {
    mockTrpc.dataSource.list.query.mockResolvedValue([{ data_source_id: "ds-1" }]);

    const result = await verifyDataSourcesPersist(mockTrpcClient, "org-1", ["ds-1", "ds-2"], {
      timeoutMs: 0,
      intervalMs: 0,
    });

    expect([...result.alive]).toEqual(["ds-1"]);
    expect([...result.dropped]).toEqual(["ds-2"]);
  });

  it("treats a list query failure as no rows present and retries within budget", async () => {
    // First poll throws (caught + logged → listed stays []), so both ids look
    // dropped and we exit immediately. Covers the dataSource.list catch block.
    mockTrpc.dataSource.list.query.mockRejectedValue(new Error("transient 503"));

    const result = await verifyDataSourcesPersist(mockTrpcClient, "org-1", ["ds-1"], {
      timeoutMs: 0,
      intervalMs: 0,
    });

    expect(result.alive.size).toBe(0);
    expect([...result.dropped]).toEqual(["ds-1"]);
  });

  it("handles a non-Error rejection from the list query", async () => {
    // A thrown non-Error value (e.g. a bare string) takes the `String(err)`
    // side of the catch's `instanceof Error` ternary.
    mockTrpc.dataSource.list.query.mockRejectedValue("boom");

    const result = await verifyDataSourcesPersist(mockTrpcClient, "org-1", ["ds-1"], {
      timeoutMs: 0,
      intervalMs: 0,
    });

    expect(result.alive.size).toBe(0);
    expect([...result.dropped]).toEqual(["ds-1"]);
  });

  it("breaks after a single poll when timeoutMs is 0 and nothing is dropped", async () => {
    // All expected present and timeoutMs === 0 → the `if (timeoutMs === 0)
    // break` exit fires after the first iteration without sleeping.
    mockTrpc.dataSource.list.query.mockResolvedValue([{ data_source_id: "ds-1" }]);

    const result = await verifyDataSourcesPersist(mockTrpcClient, "org-1", ["ds-1"], {
      timeoutMs: 0,
      intervalMs: 0,
    });

    expect([...result.alive]).toEqual(["ds-1"]);
    expect(result.dropped.size).toBe(0);
    expect(mockTrpc.dataSource.list.query).toHaveBeenCalledTimes(1);
  });

  it("keeps polling past the first iteration when timeoutMs is non-zero", async () => {
    // A small non-zero budget with zero interval: nothing is ever dropped, so
    // the `timeoutMs === 0` break is skipped and the loop sleeps and re-polls
    // until the while-condition budget elapses. Exercises the non-zero
    // timeout path through the loop without burning real time.
    mockTrpc.dataSource.list.query.mockResolvedValue([{ data_source_id: "ds-1" }]);

    const result = await verifyDataSourcesPersist(mockTrpcClient, "org-1", ["ds-1"], {
      timeoutMs: 25,
      intervalMs: 0,
    });

    expect([...result.alive]).toEqual(["ds-1"]);
    expect(result.dropped.size).toBe(0);
    // Looped more than once (re-polled after sleeping) before the budget ran out.
    expect(mockTrpc.dataSource.list.query.mock.calls.length).toBeGreaterThan(1);
  });
});
