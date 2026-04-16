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

import { sourcesCommand } from "./sources";

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
};

function allOutput(): string {
  return logSpy.mock.calls.map((c) => c.join(" ")).join("\n");
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

  it("shows '—' when provider_slug is missing", async () => {
    mockLoadConfig.mockReturnValue(validConfig);
    mockQuery.mockResolvedValueOnce([{ id: "ds1", name: "Unknown Source" }]);
    await run("list");
    const output = allOutput();
    expect(output).toContain("Unknown Source");
    expect(output).toContain("—");
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

    expect(mockMutate).toHaveBeenCalledWith("dataSource.syncDataSource", "ds1");
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
    mockLoadConfig.mockReturnValue({ ...validConfig, org_id: undefined });
    await expect(run("list")).rejects.toThrow("exit");
  });

  it("exits when access_token is missing", async () => {
    mockLoadConfig.mockReturnValue({ ...validConfig, access_token: "" });
    await expect(run("list")).rejects.toThrow("exit");
  });
});
