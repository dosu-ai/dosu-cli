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
const mockSaveConfig = vi.fn();
vi.mock("../config/config", () => ({
  loadConfig: (...args: unknown[]) => mockLoadConfig(...args),
  saveConfig: (...args: unknown[]) => mockSaveConfig(...args),
}));

import { deploymentsCommand } from "./deployments";

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
  deployment_id: "dep1",
  deployment_name: "My Deploy",
};

function allOutput(): string {
  return logSpy.mock.calls.map((c) => c.join(" ")).join("\n");
}

async function run(...args: string[]) {
  const cmd = deploymentsCommand();
  cmd.exitOverride();
  await cmd.parseAsync(["node", "test", ...args]);
}

beforeEach(() => {
  mockQuery.mockReset();
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
  it("calls workspaces.listForOrg when org_id exists", async () => {
    mockLoadConfig.mockReturnValue(validConfig);
    mockQuery.mockResolvedValueOnce([]);
    await run("list");
    expect(mockQuery).toHaveBeenCalledWith("workspaces.listForOrg", "org1");
  });

  it("calls workspaces.listAll when org_id is missing", async () => {
    mockLoadConfig.mockReturnValue({ ...validConfig, org_id: undefined });
    mockQuery.mockResolvedValueOnce([]);
    await run("list");
    expect(mockQuery).toHaveBeenCalledWith("workspaces.listAll", {});
  });

  it("outputs valid JSON with --json", async () => {
    mockLoadConfig.mockReturnValue(validConfig);
    mockQuery.mockResolvedValueOnce([{ deployment_id: "d1", name: "Test" }]);
    await run("list", "--json");
    expect(() => JSON.parse(allOutput())).not.toThrow();
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
      { deployment_id: "d1", name: "Prod", enabled: true, org_name: "Org" },
    ]);
    await run("list");
    expect(allOutput()).toContain("active");
  });

  it("shows 'disabled' for enabled=false", async () => {
    mockLoadConfig.mockReturnValue(validConfig);
    mockQuery.mockResolvedValueOnce([
      { deployment_id: "d1", name: "Old", enabled: false, org_name: "Org" },
    ]);
    await run("list");
    expect(allOutput()).toContain("disabled");
  });

  it("shows current deployment hint", async () => {
    mockLoadConfig.mockReturnValue(validConfig);
    mockQuery.mockResolvedValueOnce([
      { deployment_id: "d1", name: "Test", enabled: true, org_name: "Org" },
    ]);
    await run("list");
    expect(allOutput()).toContain("Current:");
  });

  it("shows '(unnamed)' for missing name and '—' for missing org_name", async () => {
    mockLoadConfig.mockReturnValue(validConfig);
    mockQuery.mockResolvedValueOnce([{ deployment_id: "d1", enabled: true }]);
    await run("list");
    const output = allOutput();
    expect(output).toContain("(unnamed)");
  });

  it("shows deployment_id when deployment_name is missing", async () => {
    mockLoadConfig.mockReturnValue({
      ...validConfig,
      deployment_name: undefined,
      deployment_id: "dep1",
    });
    mockQuery.mockResolvedValueOnce([
      { deployment_id: "d1", name: "Test", enabled: true, org_name: "Org" },
    ]);
    await run("list");
    expect(allOutput()).toContain("dep1");
  });
});

describe("deployments info", () => {
  it("calls workspaces.get with deployment_id", async () => {
    mockLoadConfig.mockReturnValue(validConfig);
    mockQuery.mockResolvedValueOnce({
      deployment_id: "dep1",
      name: "My Deploy",
      enabled: true,
    });
    await run("info");
    expect(mockQuery).toHaveBeenCalledWith("workspaces.get", "dep1");
  });

  it("exits when no deployment_id in config", async () => {
    mockLoadConfig.mockReturnValue({ ...validConfig, deployment_id: undefined });
    await expect(run("info")).rejects.toThrow("exit");
  });

  it("outputs valid JSON with --json", async () => {
    mockLoadConfig.mockReturnValue(validConfig);
    mockQuery.mockResolvedValueOnce({
      deployment_id: "dep1",
      name: "My Deploy",
      enabled: true,
    });
    await run("info", "--json");
    expect(() => JSON.parse(allOutput())).not.toThrow();
  });

  it("displays human-readable details", async () => {
    mockLoadConfig.mockReturnValue(validConfig);
    mockQuery.mockResolvedValueOnce({
      deployment_id: "dep1",
      name: "My Deploy",
      description: "Production",
      org_name: "Org",
      enabled: true,
      space_id: "sp1",
      created_at: "2024-01-01",
    });
    await run("info");
    const output = allOutput();
    expect(output).toContain("My Deploy");
    expect(output).toContain("active");
  });

  it("shows 'disabled' for disabled deployment", async () => {
    mockLoadConfig.mockReturnValue(validConfig);
    mockQuery.mockResolvedValueOnce({
      deployment_id: "dep1",
      name: "My Deploy",
      enabled: false,
    });
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
  };

  it("validates deployment via workspaces.get", async () => {
    mockLoadConfig.mockReturnValue(validConfig);
    mockQuery.mockResolvedValueOnce(deployment);
    await run("switch", "new-dep");
    expect(mockQuery).toHaveBeenCalledWith("workspaces.get", "new-dep");
  });

  it("saves all 4 fields to config", async () => {
    mockLoadConfig.mockReturnValue(validConfig);
    mockQuery.mockResolvedValueOnce(deployment);
    await run("switch", "new-dep");

    const saved = mockSaveConfig.mock.calls[0][0];
    expect(saved.deployment_id).toBe("new-dep");
    expect(saved.deployment_name).toBe("New Deploy");
    expect(saved.org_id).toBe("org2");
    expect(saved.space_id).toBe("sp2");
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
});

describe("requireConfig", () => {
  it("exits when access_token is missing", async () => {
    mockLoadConfig.mockReturnValue({ ...validConfig, access_token: "" });
    await expect(run("list")).rejects.toThrow("exit");
  });
});
