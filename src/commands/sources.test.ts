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

const githubStep = vi.hoisted(() => ({
  fetchListForOrg: vi.fn(),
  waitForRepositoryRefresh: vi.fn(),
  createDeploymentForRepo: vi.fn(),
  fetchOrgGithubDeployments: vi.fn(),
  fetchOrgGithubDataSources: vi.fn(),
  verifyDataSourcesPersist: vi.fn(),
  deleteOrphanDeployment: vi.fn(),
}));
vi.mock("../setup/github-step", () => githubStep);

const installationServer = vi.hoisted(() => ({
  startInstallationCallbackServer: vi.fn(),
}));
vi.mock("../setup/installation-server", () => installationServer);

vi.mock("open", () => ({ default: vi.fn() }));

vi.mock("../config/constants", async (importOriginal) => ({
  ...(await importOriginal<object>()),
  getWebAppURL: () => "https://app.example.com",
}));

import { type FlatTestConfig, makeTestConfig } from "../config/config.test-utils";
import { sourcesCommand } from "./sources";

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
};
const makeValidConfig = (overrides: Partial<FlatTestConfig> = {}) =>
  makeTestConfig({ ...validFlatConfig, ...overrides });
const validConfig = makeValidConfig();

function allOutput(): string {
  return logSpy.mock.calls.map((c: unknown[]) => c.join(" ")).join("\n");
}

async function run(...args: string[]) {
  const cmd = sourcesCommand();
  cmd.exitOverride();
  await cmd.parseAsync(["node", "test", ...args]);
}

beforeEach(() => {
  mockQuery.mockReset();
  mockMutate.mockReset();
  mockLoadConfig.mockReset();
  for (const fn of Object.values(githubStep)) fn.mockReset();
  installationServer.startInstallationCallbackServer.mockReset();
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
});

describe("sources list", () => {
  it("calls dataSource.list with org_id and outputs JSON", async () => {
    mockLoadConfig.mockReturnValue(validConfig);
    const data = [{ id: "ds1", name: "GitHub", provider_slug: "github" }];
    mockQuery.mockResolvedValueOnce(data);

    await run("list", "--json");

    expect(mockQuery).toHaveBeenCalledWith("dataSource.list", {
      org_id: "org1",
      excluded_provider_slugs: [],
    });
    const output = JSON.parse(allOutput());
    expect(output[0].name).toBe("GitHub");
  });

  it("prints message for empty results", async () => {
    mockLoadConfig.mockReturnValue(validConfig);
    mockQuery.mockResolvedValueOnce([]);
    await run("list");
    expect(allOutput()).toContain("No data sources connected");
  });

  it("shows '(unnamed)' when name is missing", async () => {
    mockLoadConfig.mockReturnValue(validConfig);
    mockQuery.mockResolvedValueOnce([{ id: "ds1", provider_slug: "github" }]);
    await run("list");
    expect(allOutput()).toContain("(unnamed)");
  });

  it("shows table with provider and name", async () => {
    mockLoadConfig.mockReturnValue(validConfig);
    mockQuery.mockResolvedValueOnce([
      { id: "ds1", name: "GitHub Repo", provider_slug: "github", created_at: "2024-01-01" },
    ]);
    await run("list");
    const output = allOutput();
    expect(output).toContain("GitHub Repo");
    expect(output).toContain("github");
  });

  it("shows '-' when provider_slug is missing", async () => {
    mockLoadConfig.mockReturnValue(validConfig);
    mockQuery.mockResolvedValueOnce([{ id: "ds1", name: "Unknown Source" }]);
    await run("list");
    const output = allOutput();
    expect(output).toContain("Unknown Source");
    expect(output).toContain("-");
  });
});

describe("sources info", () => {
  it("calls dataSource.get with id and outputs JSON", async () => {
    mockLoadConfig.mockReturnValue(validConfig);
    const ds = { id: "ds1", name: "GitHub", provider_slug: "github" };
    mockQuery.mockResolvedValueOnce(ds);

    await run("info", "--json", "ds1");

    expect(mockQuery).toHaveBeenCalledWith("dataSource.get", "ds1");
    expect(JSON.parse(allOutput())).toMatchObject(ds);
  });

  it("prints human-readable details", async () => {
    mockLoadConfig.mockReturnValue(validConfig);
    mockQuery.mockResolvedValueOnce({
      id: "ds1",
      name: "GitHub",
      description: "Main repo",
      provider_slug: "github",
      created_at: "2024-01-01",
    });

    await run("info", "ds1");

    const output = allOutput();
    expect(output).toContain("GitHub");
    expect(output).toContain("github");
  });
});

describe("sources sync", () => {
  it("calls dataSource.syncDataSource mutation", async () => {
    mockLoadConfig.mockReturnValue(validConfig);
    mockMutate.mockResolvedValueOnce({});

    await run("sync", "ds1");

    expect(mockMutate).toHaveBeenCalledWith("dataSource.syncDataSource", {
      data_source_id: "ds1",
    });
  });

  it("outputs JSON with --json", async () => {
    mockLoadConfig.mockReturnValue(validConfig);
    mockMutate.mockResolvedValueOnce({});
    await run("sync", "--json", "ds1");
    const output = JSON.parse(allOutput());
    expect(output.success).toBe(true);
  });

  it("prints human-readable confirmation", async () => {
    mockLoadConfig.mockReturnValue(validConfig);
    mockMutate.mockResolvedValueOnce({});
    await run("sync", "ds1");
    expect(allOutput()).toContain("Data source sync triggered");
  });
});

describe("sources update", () => {
  it("calls dataSource.update with name and description", async () => {
    mockLoadConfig.mockReturnValue(validConfig);
    mockMutate.mockResolvedValueOnce({});

    await run("update", "ds1", "--name", "New Name", "--description", "New desc");

    expect(mockMutate).toHaveBeenCalledWith("dataSource.update", {
      data_source_id: "ds1",
      name: "New Name",
      description: "New desc",
    });
  });

  it("outputs JSON with --json", async () => {
    mockLoadConfig.mockReturnValue(validConfig);
    mockMutate.mockResolvedValueOnce({ id: "ds1", name: "New Name" });
    await run("update", "--json", "ds1", "--name", "New Name");
    expect(JSON.parse(allOutput())).toMatchObject({ id: "ds1", name: "New Name" });
  });

  it("prints human-readable confirmation", async () => {
    mockLoadConfig.mockReturnValue(validConfig);
    mockMutate.mockResolvedValueOnce({});
    await run("update", "ds1", "--name", "New Name");
    expect(allOutput()).toContain("Data source updated");
  });

  it("rejects an update with no changes before calling tRPC", async () => {
    mockLoadConfig.mockReturnValue(validConfig);
    await expect(run("update", "ds1")).rejects.toThrow();
    expect(mockMutate).not.toHaveBeenCalled();
  });
});

describe("sources delete", () => {
  it("calls dataSource.deleteDataSource mutation", async () => {
    mockLoadConfig.mockReturnValue(validConfig);
    mockMutate.mockResolvedValueOnce({});

    await run("delete", "ds1");

    expect(mockMutate).toHaveBeenCalledWith("dataSource.deleteDataSource", "ds1");
  });

  it("outputs JSON with --json", async () => {
    mockLoadConfig.mockReturnValue(validConfig);
    mockMutate.mockResolvedValueOnce({});
    await run("delete", "--json", "ds1");
    const output = JSON.parse(allOutput());
    expect(output.success).toBe(true);
    expect(output.id).toBe("ds1");
  });

  it("prints human-readable confirmation", async () => {
    mockLoadConfig.mockReturnValue(validConfig);
    mockMutate.mockResolvedValueOnce({});
    await run("delete", "ds1");
    expect(allOutput()).toContain("Data source deleted");
  });
});

describe("requireConfig", () => {
  it("exits when org_id is missing", async () => {
    mockLoadConfig.mockReturnValue(makeValidConfig({ org_id: undefined }));
    await expect(run("list")).rejects.toThrow("exit");
  });

  it("exits when access_token is missing", async () => {
    mockLoadConfig.mockReturnValue(makeValidConfig({ access_token: "" }));
    await expect(run("list")).rejects.toThrow("exit");
  });
});

function allErrors(): string {
  return errorSpy.mock.calls.map((c: unknown[]) => c.join(" ")).join("\n");
}

function jsonLines(): unknown[] {
  return logSpy.mock.calls.map((c: unknown[]) => JSON.parse(String(c[0])));
}

function stubInstallServer(installationPromise: Promise<{ installation_id: number }>) {
  const close = vi.fn();
  installationServer.startInstallationCallbackServer.mockResolvedValue({
    server: { port: 45678, close },
    installationPromise,
  });
  return { close };
}

describe("sources connect", () => {
  it("rejects web-only providers with a JSON handoff", async () => {
    mockLoadConfig.mockReturnValue(validConfig);
    await expect(run("connect", "slack", "--json")).rejects.toThrow("exit");
    const output = JSON.parse(allOutput());
    expect(output.cli_supported).toBe(false);
    expect(output.connect_via).toBe("web");
    expect(output.url).toContain("http");
  });

  it("rejects web-only providers with a human handoff message", async () => {
    mockLoadConfig.mockReturnValue(validConfig);
    await expect(run("connect", "notion")).rejects.toThrow("exit");
    expect(allErrors()).toContain("web-only");
  });

  it("emits awaiting_install and installed NDJSON events", async () => {
    mockLoadConfig.mockReturnValue(validConfig);
    githubStep.fetchListForOrg.mockResolvedValue([]);
    const { close } = stubInstallServer(Promise.resolve({ installation_id: 42 }));
    githubStep.waitForRepositoryRefresh.mockResolvedValue({
      repos: [{ slug: "acme/api", repository_id: 7 }],
      foundNew: true,
    });

    await run("connect", "github", "--json");

    const events = jsonLines();
    expect(events[0]).toMatchObject({ event: "awaiting_install", provider: "github" });
    expect(String((events[0] as { url: string }).url)).toContain("/cli/connect-github");
    expect(String((events[0] as { url: string }).url)).toContain("45678");
    expect(events[1]).toMatchObject({
      event: "installed",
      installation_id: 42,
      new_repositories: [{ slug: "acme/api", repository_id: 7 }],
    });
    expect(close).toHaveBeenCalled();
  });

  it("times out when the install never completes", async () => {
    mockLoadConfig.mockReturnValue(validConfig);
    githubStep.fetchListForOrg.mockResolvedValue([]);
    const { close } = stubInstallServer(new Promise(() => {}));

    await expect(run("connect", "github", "--json", "--timeout", "1")).rejects.toThrow("exit");

    const events = jsonLines();
    expect(events.at(-1)).toMatchObject({ event: "timeout", timeout_seconds: 1 });
    expect(close).toHaveBeenCalled();
  }, 10_000);

  it("prints new repos and a next-step hint in human mode", async () => {
    mockLoadConfig.mockReturnValue(validConfig);
    githubStep.fetchListForOrg.mockResolvedValue([{ slug: "acme/old", repository_id: 1 }]);
    stubInstallServer(Promise.resolve({ installation_id: 9 }));
    githubStep.waitForRepositoryRefresh.mockResolvedValue({
      repos: [
        { slug: "acme/old", repository_id: 1 },
        { slug: "acme/new", repository_id: 2 },
      ],
      foundNew: true,
    });

    await run("connect", "github", "--no-open");

    const output = allOutput();
    expect(output).toContain("GitHub App connected");
    expect(output).toContain("acme/new");
    expect(output).not.toContain("acme/old\n");
    expect(output).toContain("dosu sources create github");
  });

  it("notes when no new repositories are visible yet", async () => {
    mockLoadConfig.mockReturnValue(validConfig);
    githubStep.fetchListForOrg.mockResolvedValue([]);
    stubInstallServer(Promise.resolve({ installation_id: 9 }));
    githubStep.waitForRepositoryRefresh.mockResolvedValue({ repos: [], foundNew: false });

    await run("connect", "github", "--no-open");

    expect(allOutput()).toContain("No new repositories visible yet");
  });
});

describe("sources create", () => {
  const repo = { slug: "acme/api", repository_id: 7, name: "api", is_deployed: false };

  function stubHappyPath() {
    githubStep.fetchListForOrg.mockResolvedValue([repo]);
    githubStep.fetchOrgGithubDeployments.mockResolvedValue(new Map());
    githubStep.fetchOrgGithubDataSources.mockResolvedValue(new Map());
    githubStep.createDeploymentForRepo.mockResolvedValue({
      deployment_id: "dep1",
      data_source_id: "ds1",
    });
    githubStep.verifyDataSourcesPersist.mockResolvedValue({
      alive: new Set(["ds1"]),
      dropped: new Set(),
    });
  }

  it("rejects web-only providers", async () => {
    mockLoadConfig.mockReturnValue(validConfig);
    await expect(run("create", "slack", "--repo", "x", "--confirm")).rejects.toThrow("exit");
    expect(allErrors()).toContain("web-only");
  });

  it("creates and attaches with an explicit library", async () => {
    mockLoadConfig.mockReturnValue(validConfig);
    stubHappyPath();

    await run("create", "github", "--repo", "acme/api", "--library", "lib1", "--confirm", "--json");

    expect(githubStep.createDeploymentForRepo).toHaveBeenCalledWith(
      expect.anything(),
      "org1",
      "lib1",
      repo,
      { deploymentID: undefined, dataSourceID: undefined },
    );
    const receipt = JSON.parse(allOutput());
    expect(receipt).toMatchObject({
      provider: "github",
      repository: "acme/api",
      repository_id: 7,
      data_source_id: "ds1",
      deployment_id: "dep1",
      library_id: "lib1",
      attached: true,
    });
  });

  it("defaults to the active library", async () => {
    mockLoadConfig.mockReturnValue(makeValidConfig({ space_id: "space9" }));
    stubHappyPath();

    await run("create", "github", "--repo", "acme/api", "--confirm", "--json");

    expect(githubStep.createDeploymentForRepo).toHaveBeenCalledWith(
      expect.anything(),
      "org1",
      "space9",
      repo,
      expect.anything(),
    );
  });

  it("reuses existing deployment and data source rows", async () => {
    mockLoadConfig.mockReturnValue(validConfig);
    stubHappyPath();
    githubStep.fetchOrgGithubDeployments.mockResolvedValue(new Map([[7, "dep-old"]]));
    githubStep.fetchOrgGithubDataSources.mockResolvedValue(new Map([[7, "ds-old"]]));

    await run("create", "github", "--repo", "acme/api", "--library", "lib1", "--confirm", "--json");

    expect(githubStep.createDeploymentForRepo).toHaveBeenCalledWith(
      expect.anything(),
      "org1",
      "lib1",
      repo,
      { deploymentID: "dep-old", dataSourceID: "ds-old" },
    );
  });

  it("exits when no library is specified and none is active", async () => {
    mockLoadConfig.mockReturnValue(makeValidConfig({ space_id: undefined }));
    await expect(run("create", "github", "--repo", "acme/api", "--confirm")).rejects.toThrow(
      "exit",
    );
    expect(allErrors()).toContain("--library");
  });

  it("exits when the repository is not visible to Dosu", async () => {
    mockLoadConfig.mockReturnValue(validConfig);
    githubStep.fetchListForOrg.mockResolvedValue([]);
    await expect(
      run("create", "github", "--repo", "acme/missing", "--library", "lib1", "--confirm"),
    ).rejects.toThrow("exit");
    expect(allErrors()).toContain("not visible");
    expect(allErrors()).toContain("dosu sources connect github");
  });

  it("exits for forked repositories", async () => {
    mockLoadConfig.mockReturnValue(validConfig);
    githubStep.fetchListForOrg.mockResolvedValue([
      { ...repo, is_fork: true, fork_parent_slug: "upstream/api" },
    ]);
    await expect(
      run("create", "github", "--repo", "acme/api", "--library", "lib1", "--confirm"),
    ).rejects.toThrow("exit");
    expect(allErrors()).toContain("fork");
    expect(allErrors()).toContain("upstream/api");
  });

  it("requires confirmation in JSON mode", async () => {
    mockLoadConfig.mockReturnValue(validConfig);
    githubStep.fetchListForOrg.mockResolvedValue([repo]);

    await run("create", "github", "--repo", "acme/api", "--library", "lib1", "--json");

    const output = JSON.parse(allOutput());
    expect(output.confirmRequired).toBe(true);
    expect(githubStep.createDeploymentForRepo).not.toHaveBeenCalled();
  });

  it("exits when the wiring fails", async () => {
    mockLoadConfig.mockReturnValue(validConfig);
    stubHappyPath();
    githubStep.createDeploymentForRepo.mockResolvedValue(null);

    await expect(
      run("create", "github", "--repo", "acme/api", "--library", "lib1", "--confirm"),
    ).rejects.toThrow("exit");
    expect(allErrors()).toContain("Could not create the data source");
  });

  it("reverts the deployment when the backend drops the data source", async () => {
    mockLoadConfig.mockReturnValue(validConfig);
    stubHappyPath();
    githubStep.verifyDataSourcesPersist.mockResolvedValue({
      alive: new Set(),
      dropped: new Set(["ds1"]),
    });

    await expect(
      run("create", "github", "--repo", "acme/api", "--library", "lib1", "--confirm"),
    ).rejects.toThrow("exit");
    expect(githubStep.deleteOrphanDeployment).toHaveBeenCalledWith(
      expect.anything(),
      "dep1",
      "acme/api",
    );
    expect(allErrors()).toContain("couldn't sync");
  });

  it("prints a human-readable receipt", async () => {
    mockLoadConfig.mockReturnValue(validConfig);
    stubHappyPath();

    await run("create", "github", "--repo", "acme/api", "--library", "lib1", "--confirm");

    const output = allOutput();
    expect(output).toContain("Connected acme/api to library lib1");
    expect(output).toContain("ds1");
    expect(output).toContain("dep1");
  });
});
