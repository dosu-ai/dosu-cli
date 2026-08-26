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

const mockCreateAPIKey = vi.fn();
vi.mock("../client/client", () => ({
  Client: class {
    createAPIKey = mockCreateAPIKey;
  },
}));

const mockLoadConfig = vi.fn();
const mockSaveConfig = vi.fn();
vi.mock("../config/config", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../config/config")>()),
  loadConfig: (...args: unknown[]) => mockLoadConfig(...args),
  saveConfig: (...args: unknown[]) => mockSaveConfig(...args),
}));

import { type FlatTestConfig, makeTestConfig, testTarget } from "../config/config.test-utils";
import { deploymentsCommand } from "./deployments";

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
  deployment_id: "dep1",
  deployment_name: "My Deploy",
};
const makeValidConfig = (overrides: Partial<FlatTestConfig> = {}) =>
  makeTestConfig({ ...validFlatConfig, ...overrides });
const validConfig = makeValidConfig();

function allOutput(): string {
  return logSpy.mock.calls.map((c: unknown[]) => c.join(" ")).join("\n");
}

async function run(...args: string[]) {
  const cmd = deploymentsCommand();
  cmd.exitOverride();
  await cmd.parseAsync(["node", "test", ...args]);
}

beforeEach(() => {
  mockQuery.mockReset();
  mockCreateAPIKey.mockReset();
  mockCreateAPIKey.mockResolvedValue({ api_key: "fresh-key" });
  mockLoadConfig.mockReset();
  mockSaveConfig.mockReset();
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

describe("deployments list", () => {
  it("only returns MCP deployments that the CLI can target", async () => {
    mockLoadConfig.mockReturnValue(validConfig);
    mockQuery.mockResolvedValueOnce([
      { deployment_id: "github-1", name: "Repo", provider_slug: "github" },
      { deployment_id: "mcp-1", name: "Dosu MCP", provider_slug: "dosu_mcp" },
    ]);

    await run("list", "--json");

    expect(JSON.parse(allOutput())).toEqual([
      { deployment_id: "mcp-1", name: "Dosu MCP", provider_slug: "dosu_mcp" },
    ]);
  });

  it("calls workspaces.listForOrg when org_id exists", async () => {
    mockLoadConfig.mockReturnValue(validConfig);
    mockQuery.mockResolvedValueOnce([]);
    await run("list");
    expect(mockQuery).toHaveBeenCalledWith("workspaces.listForOrg", "org1");
  });

  it("lists each accessible org when no active org is selected", async () => {
    mockLoadConfig.mockReturnValue(makeValidConfig({ org_id: undefined }));
    mockQuery.mockImplementation((path: string, input: unknown) => {
      if (path === "organization.getOrganizations") {
        return Promise.resolve([
          { org_id: "org1", name: "One" },
          { org_id: "org2", name: "Two" },
        ]);
      }
      if (path === "workspaces.listForOrg") return Promise.resolve([]);
      throw new Error(`unexpected query: ${path} ${String(input)}`);
    });
    await run("list");
    expect(mockQuery).toHaveBeenCalledWith("workspaces.listForOrg", "org1");
    expect(mockQuery).toHaveBeenCalledWith("workspaces.listForOrg", "org2");
    expect(mockQuery).not.toHaveBeenCalledWith("workspaces.listAll", expect.anything());
  });

  it("outputs valid JSON with --json", async () => {
    mockLoadConfig.mockReturnValue(validConfig);
    mockQuery.mockResolvedValueOnce([
      { deployment_id: "d1", name: "Test", provider_slug: "dosu_mcp" },
    ]);
    await run("list", "--json");
    const output = JSON.parse(allOutput());
    expect(output).toHaveLength(1);
    expect(output[0]).toMatchObject({ deployment_id: "d1", name: "Test" });
  });

  it("prints message for empty results", async () => {
    mockLoadConfig.mockReturnValue(validConfig);
    mockQuery.mockResolvedValueOnce([]);
    await run("list");
    expect(allOutput()).toContain("No deployments found");
  });

  it("shows 'active' for enabled=true", async () => {
    mockLoadConfig.mockReturnValue(validConfig);
    mockQuery.mockResolvedValueOnce([
      {
        deployment_id: "d1",
        name: "Prod",
        enabled: true,
        org_id: "org1",
        provider_slug: "dosu_mcp",
      },
    ]);
    await run("list");
    expect(allOutput()).toContain("active");
  });

  it("shows 'disabled' for enabled=false", async () => {
    mockLoadConfig.mockReturnValue(validConfig);
    mockQuery.mockResolvedValueOnce([
      {
        deployment_id: "d1",
        name: "Old",
        enabled: false,
        org_id: "org1",
        provider_slug: "dosu_mcp",
      },
    ]);
    await run("list");
    expect(allOutput()).toContain("disabled");
  });

  it("shows current deployment hint", async () => {
    mockLoadConfig.mockReturnValue(validConfig);
    mockQuery.mockResolvedValueOnce([
      {
        deployment_id: "d1",
        name: "Test",
        enabled: true,
        org_id: "org1",
        provider_slug: "dosu_mcp",
      },
    ]);
    await run("list");
    expect(allOutput()).toContain("Current: My Deploy");
  });

  it("shows truncated org_id", async () => {
    mockLoadConfig.mockReturnValue(validConfig);
    mockQuery.mockResolvedValueOnce([
      {
        deployment_id: "d1",
        name: "Prod",
        enabled: true,
        org_id: "0123456789abcdef",
        provider_slug: "dosu_mcp",
      },
    ]);
    await run("list");
    expect(allOutput()).toContain("01234567");
  });

  it("shows '(unnamed)' for missing name and '—' for missing org_id", async () => {
    mockLoadConfig.mockReturnValue(validConfig);
    mockQuery.mockResolvedValueOnce([
      { deployment_id: "d1", enabled: true, provider_slug: "dosu_mcp" },
    ]);
    await run("list");
    const output = allOutput();
    expect(output).toContain("(unnamed)");
    expect(output).toContain("—");
  });

  it("shows deployment_id when deployment_name is missing", async () => {
    mockLoadConfig.mockReturnValue(
      makeValidConfig({
        deployment_name: undefined,
        deployment_id: "dep1",
      }),
    );
    mockQuery.mockResolvedValueOnce([
      {
        deployment_id: "d1",
        name: "Test",
        enabled: true,
        org_id: "org1",
        provider_slug: "dosu_mcp",
      },
    ]);
    await run("list");
    expect(allOutput()).toContain("Current: dep1");
  });
});

describe("deployments info", () => {
  it("calls workspaces.get with deployment_id", async () => {
    mockLoadConfig.mockReturnValue(validConfig);
    mockQuery.mockResolvedValueOnce({
      deployment_id: "dep1",
      name: "My Deploy",
      org_id: "org1",
      enabled: true,
    });
    mockQuery.mockResolvedValueOnce({ name: "Org" });
    await run("info");
    expect(mockQuery).toHaveBeenCalledWith("workspaces.get", "dep1");
  });

  it("exits when no deployment_id in config", async () => {
    mockLoadConfig.mockReturnValue(makeValidConfig({ deployment_id: undefined }));
    await expect(run("info")).rejects.toThrow("exit");
  });

  it("exits when deployment is not found", async () => {
    mockLoadConfig.mockReturnValue(validConfig);
    mockQuery.mockResolvedValueOnce(null);
    await expect(run("info")).rejects.toThrow("exit");
  });

  it("outputs valid JSON with --json", async () => {
    mockLoadConfig.mockReturnValue(validConfig);
    mockQuery.mockResolvedValueOnce({
      deployment_id: "dep1",
      name: "My Deploy",
      org_id: "org1",
      enabled: true,
    });
    mockQuery.mockResolvedValueOnce({ name: "Org" });
    await run("info", "--json");
    const output = JSON.parse(allOutput());
    expect(output).toMatchObject({
      deployment_id: "dep1",
      name: "My Deploy",
      enabled: true,
    });
  });

  it("displays human-readable details", async () => {
    mockLoadConfig.mockReturnValue(validConfig);
    mockQuery.mockResolvedValueOnce({
      deployment_id: "dep1",
      name: "My Deploy",
      description: "Production",
      org_id: "org1",
      enabled: true,
      space_id: "sp1",
      created_at: "2024-01-01",
    });
    mockQuery.mockResolvedValueOnce({ name: "Org" });
    await run("info");
    const output = allOutput();
    expect(output).toContain("My Deploy");
    expect(output).toContain("Production");
    expect(output).toContain("Org");
    expect(output).toContain("active");
    expect(output).toContain("sp1");
  });

  it("falls back to org_id when organization lookup returns null", async () => {
    mockLoadConfig.mockReturnValue(validConfig);
    mockQuery.mockResolvedValueOnce({
      deployment_id: "dep1",
      name: "My Deploy",
      org_id: "org1",
      enabled: true,
    });
    mockQuery.mockResolvedValueOnce(null);
    await run("info");
    expect(allOutput()).toContain("org1");
  });

  it("shows 'disabled' for disabled deployment", async () => {
    mockLoadConfig.mockReturnValue(validConfig);
    mockQuery.mockResolvedValueOnce({
      deployment_id: "dep1",
      name: "My Deploy",
      org_id: "org1",
      enabled: false,
    });
    mockQuery.mockResolvedValueOnce({ name: "Org" });
    await run("info");
    expect(allOutput()).toContain("disabled");
  });
});

describe("deployments switch", () => {
  const deployment = {
    deployment_id: "new-dep",
    name: "New Deploy",
    org_id: "org2",
    space_id: "sp2",
    provider_slug: "dosu_mcp",
  };

  it("validates deployment via workspaces.get", async () => {
    mockLoadConfig.mockReturnValue(validConfig);
    mockQuery.mockResolvedValueOnce(deployment);
    await run("switch", "new-dep");
    expect(mockQuery).toHaveBeenCalledWith("workspaces.get", "new-dep");
  });

  it("saves the deployment fields with a newly scoped API key", async () => {
    mockLoadConfig.mockReturnValue(validConfig);
    mockQuery.mockResolvedValueOnce(deployment);
    await run("switch", "new-dep");

    const savedTarget = testTarget(mockSaveConfig.mock.calls[0][0]);
    expect(savedTarget.deployment_id).toBe("new-dep");
    expect(savedTarget.deployment_name).toBe("New Deploy");
    expect(savedTarget.org_id).toBe("org2");
    expect(savedTarget.space_id).toBe("sp2");
    expect(savedTarget.api_key).toBe("fresh-key");
    expect(mockCreateAPIKey).toHaveBeenCalledWith("new-dep", "dosu-cli");
  });

  it("outputs JSON with --json", async () => {
    mockLoadConfig.mockReturnValue(validConfig);
    mockQuery.mockResolvedValueOnce(deployment);
    await run("switch", "--json", "new-dep");

    const output = JSON.parse(allOutput());
    expect(output.success).toBe(true);
    expect(output.deployment_id).toBe("new-dep");
  });

  it("prints human-readable confirmation", async () => {
    mockLoadConfig.mockReturnValue(validConfig);
    mockQuery.mockResolvedValueOnce(deployment);
    await run("switch", "new-dep");
    expect(allOutput()).toContain("New Deploy");
  });

  it("exits when deployment is not found", async () => {
    mockLoadConfig.mockReturnValue(validConfig);
    mockQuery.mockResolvedValueOnce(null);
    await expect(run("switch", "missing-dep")).rejects.toThrow("exit");
    expect(mockSaveConfig).not.toHaveBeenCalled();
  });

  it("rejects a non-MCP workspace before creating an API key", async () => {
    mockLoadConfig.mockReturnValue(validConfig);
    mockQuery.mockResolvedValueOnce({ ...deployment, provider_slug: "github" });

    await expect(run("switch", "new-dep")).rejects.toThrow("exit");

    expect(mockCreateAPIKey).not.toHaveBeenCalled();
    expect(mockSaveConfig).not.toHaveBeenCalled();
  });
});

describe("requireConfig", () => {
  it("exits when access_token is missing", async () => {
    mockLoadConfig.mockReturnValue(makeValidConfig({ access_token: "" }));
    await expect(run("list")).rejects.toThrow("exit");
  });
});
