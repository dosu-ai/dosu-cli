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

import { type FlatTestConfig, makeTestConfig } from "../config/config.test-utils";
import { integrationsCommand } from "./integrations";

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
  const cmd = integrationsCommand();
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

describe("integrations list", () => {
  it("queries nango platforms and shows connection status", async () => {
    mockLoadConfig.mockReturnValue(validConfig);
    // Only nango-supported platforms are queried: gitlab, confluence, notion, coda
    mockQuery
      .mockResolvedValueOnce(null) // gitlab - not connected
      .mockResolvedValueOnce({ id: "conn2" }) // confluence - connected
      .mockResolvedValueOnce(null) // notion - not connected
      .mockResolvedValueOnce(null); // coda - not connected

    await run("list");

    const output = allOutput();
    expect(output).toContain("github");
    expect(output).toContain("connected");
    expect(output).toContain("not connected");
  });

  it("outputs valid JSON with --json", async () => {
    mockLoadConfig.mockReturnValue(validConfig);
    for (let i = 0; i < 4; i++) mockQuery.mockResolvedValueOnce(null);

    await run("list", "--json");

    const output = JSON.parse(allOutput());
    expect(Array.isArray(output)).toBe(true);
    expect(output[0]).toHaveProperty("platform");
    expect(output[0]).toHaveProperty("connected");
  });
});

describe("integrations status", () => {
  it("shows connected status for a valid connection", async () => {
    mockLoadConfig.mockReturnValue(validConfig);
    mockQuery.mockResolvedValueOnce({ id: "conn1", status: "active" });

    await run("status", "confluence");

    expect(allOutput()).toContain("connected");
  });

  it("shows not connected on error", async () => {
    mockLoadConfig.mockReturnValue(validConfig);
    mockQuery.mockRejectedValueOnce(new Error("not found"));

    await run("status", "gitlab");

    expect(allOutput()).toContain("not connected");
  });

  it("shows not connected when connection is null", async () => {
    mockLoadConfig.mockReturnValue(validConfig);
    mockQuery.mockResolvedValueOnce(null);

    await run("status", "confluence");

    expect(allOutput()).toContain("not connected");
  });
});

describe("integrations slack-channels", () => {
  it("calls slackChannel.getAll", async () => {
    mockLoadConfig.mockReturnValue(validConfig);
    mockQuery.mockResolvedValueOnce([{ id: "C123", name: "general" }]);

    await run("slack-channels");

    expect(mockQuery).toHaveBeenCalledWith("slackChannel.getAll", "org1");
    expect(allOutput()).toContain("general");
  });

  it("prints message for empty channels", async () => {
    mockLoadConfig.mockReturnValue(validConfig);
    mockQuery.mockResolvedValueOnce([]);
    await run("slack-channels");
    expect(allOutput()).toContain("No Slack channels found");
  });
});

describe("integrations slack-join", () => {
  it("calls slackChannel.join mutation", async () => {
    mockLoadConfig.mockReturnValue(validConfig);
    mockMutate.mockResolvedValueOnce({});

    await run("slack-join", "C123");

    expect(mockMutate).toHaveBeenCalledWith("slackChannel.join", "C123");
  });
});

describe("integrations github-collaborators", () => {
  it("lists collaborators", async () => {
    mockLoadConfig.mockReturnValue(validConfig);
    mockQuery.mockResolvedValueOnce([
      { user_name: "octocat", full_name: "Mona", email: "mona@gh.com" },
    ]);

    await run("github-collaborators");

    const output = allOutput();
    expect(output).toContain("octocat");
    expect(output).toContain("Mona");
  });

  it("prints message for empty results", async () => {
    mockLoadConfig.mockReturnValue(validConfig);
    mockQuery.mockResolvedValueOnce([]);
    await run("github-collaborators");
    expect(allOutput()).toContain("No collaborators found");
  });

  it("handles missing username, name, and email fields", async () => {
    mockLoadConfig.mockReturnValue(validConfig);
    mockQuery.mockResolvedValueOnce([{}]);
    await run("github-collaborators");
    // All undefined fields should be replaced with "—"
    const output = allOutput();
    expect(output).toContain("—");
  });
});

describe("integrations status (JSON branches)", () => {
  it("outputs JSON for connected status", async () => {
    mockLoadConfig.mockReturnValue(validConfig);
    mockQuery.mockResolvedValueOnce({ id: "conn1", status: "active" });

    await run("status", "--json", "confluence");

    const output = JSON.parse(allOutput());
    expect(output.platform).toBe("confluence");
    expect(output.connected).toBe(true);
    expect(output.connection).toBeTruthy();
  });

  it("outputs JSON for error/not connected", async () => {
    mockLoadConfig.mockReturnValue(validConfig);
    mockQuery.mockRejectedValueOnce(new Error("fail"));

    await run("status", "--json", "gitlab");

    const output = JSON.parse(allOutput());
    expect(output.platform).toBe("gitlab");
    expect(output.connected).toBe(false);
  });
});

describe("integrations slack-channels (JSON branch)", () => {
  it("outputs valid JSON with --json", async () => {
    mockLoadConfig.mockReturnValue(validConfig);
    mockQuery.mockResolvedValueOnce([{ id: "C123", name: "general" }]);

    await run("slack-channels", "--json");

    const output = JSON.parse(allOutput());
    expect(Array.isArray(output)).toBe(true);
    expect(output[0].name).toBe("general");
  });
});

describe("integrations slack-join (JSON and human branches)", () => {
  it("outputs JSON with --json", async () => {
    mockLoadConfig.mockReturnValue(validConfig);
    mockMutate.mockResolvedValueOnce({});

    await run("slack-join", "--json", "C123");

    const output = JSON.parse(allOutput());
    expect(output.success).toBe(true);
    expect(output.channelId).toBe("C123");
  });

  it("prints human-readable confirmation", async () => {
    mockLoadConfig.mockReturnValue(validConfig);
    mockMutate.mockResolvedValueOnce({});

    await run("slack-join", "C123");

    expect(allOutput()).toContain("Joined Slack channel");
  });
});

describe("integrations github-collaborators (JSON branch)", () => {
  it("outputs valid JSON with --json", async () => {
    mockLoadConfig.mockReturnValue(validConfig);
    mockQuery.mockResolvedValueOnce([
      { user_name: "octocat", full_name: "Mona", email: "mona@gh.com" },
    ]);

    await run("github-collaborators", "--json");

    const output = JSON.parse(allOutput());
    expect(Array.isArray(output)).toBe(true);
    expect(output[0].user_name).toBe("octocat");
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
