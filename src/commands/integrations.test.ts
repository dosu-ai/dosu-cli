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

import { integrationsCommand } from "./integrations";

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
  // `list` probes platforms in parallel, so the mock keys off the query input
  // (providerConfigKey) rather than a fixed call order.
  function mockConnectedKeys(...connectedKeys: string[]) {
    const set = new Set(connectedKeys);
    mockQuery.mockImplementation((_path: string, input: { providerConfigKey: string }) =>
      Promise.resolve(set.has(input.providerConfigKey) ? { id: input.providerConfigKey } : null),
    );
  }

  it("queries nango platforms and shows connection status", async () => {
    mockLoadConfig.mockReturnValue(validConfig);
    mockConnectedKeys("confluence"); // only confluence connected

    await run("list");

    const output = allOutput();
    expect(output).toContain("github");
    expect(output).toContain("azure_devops");
    expect(output).toContain("connected");
    expect(output).toContain("not connected");
  });

  it("outputs valid JSON with --json", async () => {
    mockLoadConfig.mockReturnValue(validConfig);
    mockQuery.mockResolvedValue(null); // nothing connected, any number of probes

    await run("list", "--json");

    const output = JSON.parse(allOutput());
    expect(Array.isArray(output)).toBe(true);
    // DISPLAY_PLATFORMS: github, gitlab, azure_devops, slack, confluence, notion, coda, teams
    expect(output).toHaveLength(8);
    expect(output[0]).toHaveProperty("platform");
    expect(output[0]).toHaveProperty("connected");
  });

  it("includes azure_devops connected via OAuth", async () => {
    mockLoadConfig.mockReturnValue(validConfig);
    mockConnectedKeys("microsoft-entra-id"); // ADO connected via OAuth only

    await run("list", "--json");

    const output = JSON.parse(allOutput());
    const ado = output.find((r: { platform: string }) => r.platform === "azure_devops");
    expect(ado.connected).toBe(true);
  });

  it("reports gitlab connected when only a PAT connection exists", async () => {
    mockLoadConfig.mockReturnValue(validConfig);
    mockConnectedKeys("gitlab-pat"); // GitLab connected via PAT, not OAuth

    await run("list", "--json");

    const output = JSON.parse(allOutput());
    const gitlab = output.find((r: { platform: string }) => r.platform === "gitlab");
    expect(gitlab.connected).toBe(true);
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

describe("integrations status azure_devops", () => {
  it("reports connected via PAT and short-circuits before the OAuth probe", async () => {
    mockLoadConfig.mockReturnValue(validConfig);
    mockQuery.mockResolvedValueOnce({ id: "ado-pat" });

    await run("status", "azure_devops");

    expect(mockQuery).toHaveBeenCalledTimes(1);
    expect(mockQuery.mock.calls[0][1]).toMatchObject({
      provider: "azure_devops",
      providerConfigKey: "azure-devops",
    });
    const output = allOutput();
    expect(output).toContain("connected");
    // "not connected" contains the substring "connected", so assert it is absent
    expect(output).not.toContain("not connected");
  });

  it("falls back to the OAuth probe when PAT is not connected", async () => {
    mockLoadConfig.mockReturnValue(validConfig);
    mockQuery
      .mockResolvedValueOnce(null) // PAT - not connected
      .mockResolvedValueOnce({ id: "ado-oauth" }); // OAuth - connected

    await run("status", "azure_devops");

    expect(mockQuery).toHaveBeenCalledTimes(2);
    expect(mockQuery.mock.calls[1][1]).toMatchObject({
      provider: "microsoft-entra-id",
      providerConfigKey: "microsoft-entra-id",
    });
    const output = allOutput();
    expect(output).toContain("connected");
    expect(output).not.toContain("not connected");
  });

  it("reports not connected when neither probe returns a connection", async () => {
    mockLoadConfig.mockReturnValue(validConfig);
    mockQuery.mockResolvedValueOnce(null).mockResolvedValueOnce(null);

    await run("status", "azure_devops");

    expect(mockQuery).toHaveBeenCalledTimes(2);
    expect(allOutput()).toContain("not connected");
  });

  it("continues past a probe that throws", async () => {
    mockLoadConfig.mockReturnValue(validConfig);
    mockQuery
      .mockRejectedValueOnce(new Error("boom")) // PAT throws
      .mockResolvedValueOnce({ id: "ado-oauth" }); // OAuth - connected

    await run("status", "azure_devops");

    expect(mockQuery).toHaveBeenCalledTimes(2);
    const output = allOutput();
    expect(output).toContain("connected");
    expect(output).not.toContain("not connected");
  });

  it("outputs JSON with the connection payload when connected", async () => {
    mockLoadConfig.mockReturnValue(validConfig);
    mockQuery.mockResolvedValueOnce({ id: "ado-pat" });

    await run("status", "--json", "azure_devops");

    const output = JSON.parse(allOutput());
    expect(output.platform).toBe("azure_devops");
    expect(output.connected).toBe(true);
    expect(output.connection).toBeTruthy();
  });
});

describe("integrations status gitlab (multi-auth)", () => {
  it("detects a GitLab PAT connection via the fallback probe", async () => {
    mockLoadConfig.mockReturnValue(validConfig);
    mockQuery
      .mockResolvedValueOnce(null) // gitlab OAuth - not connected
      .mockResolvedValueOnce({ id: "gl-pat" }); // gitlab-pat - connected

    await run("status", "gitlab");

    expect(mockQuery).toHaveBeenCalledTimes(2);
    expect(mockQuery.mock.calls[1][1]).toMatchObject({
      provider: "gitlab",
      providerConfigKey: "gitlab-pat",
    });
    const output = allOutput();
    expect(output).toContain("connected");
    expect(output).not.toContain("not connected");
  });

  it("still supports `status gitlab-pat` as a standalone platform", async () => {
    mockLoadConfig.mockReturnValue(validConfig);
    mockQuery.mockResolvedValueOnce({ id: "gl-pat" });

    await run("status", "gitlab-pat");

    expect(mockQuery).toHaveBeenCalledTimes(1);
    expect(mockQuery.mock.calls[0][1]).toMatchObject({
      provider: "gitlab",
      providerConfigKey: "gitlab-pat",
    });
    expect(allOutput()).toContain("connected");
  });
});

describe("integrations status (not queryable via nango)", () => {
  it("reports github as not connected without issuing a nango query", async () => {
    mockLoadConfig.mockReturnValue(validConfig);

    await run("status", "github");

    expect(mockQuery).not.toHaveBeenCalled();
    expect(allOutput()).toContain("not connected");
  });

  it("outputs a JSON note for a not-queryable platform", async () => {
    mockLoadConfig.mockReturnValue(validConfig);

    await run("status", "--json", "github");

    const output = JSON.parse(allOutput());
    expect(output.platform).toBe("github");
    expect(output.connected).toBe(false);
    expect(output.note).toContain("not queryable");
    expect(mockQuery).not.toHaveBeenCalled();
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
    mockLoadConfig.mockReturnValue({ ...validConfig, org_id: undefined });
    await expect(run("list")).rejects.toThrow("exit");
  });

  it("exits when access_token is missing", async () => {
    mockLoadConfig.mockReturnValue({ ...validConfig, access_token: "" });
    await expect(run("list")).rejects.toThrow("exit");
  });
});
