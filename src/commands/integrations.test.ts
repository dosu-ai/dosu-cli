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
import type { CliSlackChannel, SlackChannelListPagedOutput } from "../generated/dosu-api-types";
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

// CI forces color on, so picocolors wraps labels in ANSI codes; assert on the plain text.
// biome-ignore lint/suspicious/noControlCharactersInRegex: matching ANSI escapes needs ESC.
const stripAnsi = (text: string) => text.replaceAll(/\u001B\[[0-9;]*m/g, "");

function stdout(): string {
  return stripAnsi(allOutput());
}

function stderr(): string {
  return stripAnsi(errorSpy.mock.calls.map((c: unknown[]) => c.join(" ")).join("\n"));
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

  it("surfaces tRPC errors instead of reporting a false disconnected state", async () => {
    mockLoadConfig.mockReturnValue(validConfig);
    mockQuery.mockRejectedValueOnce(new Error("not found"));

    await expect(run("status", "gitlab")).rejects.toThrow("not found");
  });

  it("rejects unknown platforms before calling tRPC", async () => {
    mockLoadConfig.mockReturnValue(validConfig);
    await expect(run("status", "unknown")).rejects.toThrow();
    expect(mockQuery).not.toHaveBeenCalled();
  });

  it("shows not connected when connection is null", async () => {
    mockLoadConfig.mockReturnValue(validConfig);
    mockQuery.mockResolvedValueOnce(null);

    await run("status", "confluence");

    expect(allOutput()).toContain("not connected");
  });
});

describe("integrations status azure_devops", () => {
  it("reports connected via OAuth (primary) and short-circuits before the PAT probe", async () => {
    mockLoadConfig.mockReturnValue(validConfig);
    mockQuery.mockResolvedValueOnce({ id: "ado-oauth" });

    await run("status", "azure_devops");

    expect(mockQuery).toHaveBeenCalledTimes(1);
    expect(mockQuery.mock.calls[0][1]).toMatchObject({
      provider: "microsoft-entra-id",
      providerConfigKey: "microsoft-entra-id",
    });
    const output = allOutput();
    expect(output).toContain("connected");
    // "not connected" contains the substring "connected", so assert it is absent
    expect(output).not.toContain("not connected");
  });

  it("falls back to the PAT probe when OAuth is not connected", async () => {
    mockLoadConfig.mockReturnValue(validConfig);
    mockQuery
      .mockResolvedValueOnce(null) // OAuth - not connected
      .mockResolvedValueOnce({ id: "ado-pat" }); // PAT - connected

    await run("status", "azure_devops");

    expect(mockQuery).toHaveBeenCalledTimes(2);
    expect(mockQuery.mock.calls[1][1]).toMatchObject({
      provider: "azure_devops",
      providerConfigKey: "azure-devops",
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

  it("propagates a probe error instead of reporting stale connection state", async () => {
    mockLoadConfig.mockReturnValue(validConfig);
    mockQuery.mockRejectedValueOnce(new Error("boom"));

    await expect(run("status", "azure_devops")).rejects.toThrow("boom");

    expect(mockQuery).toHaveBeenCalledTimes(1);
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

  it("rejects the obsolete standalone gitlab-pat platform", async () => {
    mockLoadConfig.mockReturnValue(validConfig);

    await expect(run("status", "gitlab-pat")).rejects.toThrow();

    expect(mockQuery).not.toHaveBeenCalled();
  });
});

describe("integrations status (not queryable via nango)", () => {
  it("reports github status as unavailable without issuing a nango query", async () => {
    mockLoadConfig.mockReturnValue(validConfig);

    await run("status", "github");

    expect(mockQuery).not.toHaveBeenCalled();
    expect(allOutput()).toContain("status unavailable");
  });

  it("outputs a JSON note for a not-queryable platform", async () => {
    mockLoadConfig.mockReturnValue(validConfig);

    await run("status", "--json", "github");

    const output = JSON.parse(allOutput());
    expect(output.platform).toBe("github");
    expect(output.connected).toBeNull();
    expect(output.note).toContain("status unavailable");
    expect(mockQuery).not.toHaveBeenCalled();
  });
});

const CHANNEL_A = "00000000-0000-4000-8000-00000000000a";
const CHANNEL_B = "00000000-0000-4000-8000-00000000000b";

function channel(overrides: Partial<CliSlackChannel> = {}): CliSlackChannel {
  return {
    archived: false,
    channel_id: "C0000000A",
    channel_type: "channel",
    description: null,
    enterprise_id: null,
    id: CHANNEL_A,
    installation_id: "00000000-0000-4000-8000-0000000000f1",
    is_private: false,
    name: "eng",
    org_id: "org1",
    team_id: "T1",
    team_name: "Acme",
    topic: null,
    ...overrides,
  };
}

/** Answer `slackChannel.listPaged` from a queue of pages. */
function servePages(...pages: SlackChannelListPagedOutput[]) {
  const queue = [...pages];
  mockQuery.mockImplementation(async (path: string) => {
    if (path !== "slackChannel.listPaged") throw new Error(`unexpected query ${path}`);
    const page = queue.shift();
    if (!page) throw new Error("unexpected listPaged call");
    return page;
  });
}

function listPagedCalls(): unknown[] {
  return mockQuery.mock.calls
    .filter(([path]) => path === "slackChannel.listPaged")
    .map((c) => c[1]);
}

describe("integrations slack-channels", () => {
  it("shows both the UUID and the Slack ID", async () => {
    mockLoadConfig.mockReturnValue(validConfig);
    mockQuery.mockResolvedValueOnce([channel()]);

    await run("slack-channels");

    expect(mockQuery).toHaveBeenCalledWith("slackChannel.getAll", "org1");
    const out = stdout();
    expect(out).toMatch(/UUID\s+Slack ID\s+Name\s+Workspace/);
    expect(out).toMatch(new RegExp(`${CHANNEL_A}\\s+C0000000A\\s+eng\\s+Acme`));
  });

  it("prints message for empty channels", async () => {
    mockLoadConfig.mockReturnValue(validConfig);
    mockQuery.mockResolvedValueOnce([]);
    await run("slack-channels");
    expect(allOutput()).toContain("No Slack channels found");
  });

  it("prints the raw rows unchanged with --json", async () => {
    mockLoadConfig.mockReturnValue(validConfig);
    const rows = [channel(), { id: CHANNEL_B, channel_id: "D0000000B", name: null }];
    mockQuery.mockResolvedValueOnce(rows);

    await run("slack-channels", "--json");

    expect(JSON.parse(stdout())).toEqual(rows);
  });
});

describe("integrations slack-join", () => {
  it("passes a UUID straight to slackChannel.join", async () => {
    mockLoadConfig.mockReturnValue(validConfig);
    mockMutate.mockResolvedValueOnce(true);

    await run("slack-join", CHANNEL_B);

    expect(listPagedCalls()).toHaveLength(0);
    expect(mockMutate).toHaveBeenCalledWith("slackChannel.join", CHANNEL_B);
    expect(stdout()).toContain(`Joined Slack channel ${CHANNEL_B}.`);
  });

  it("resolves a Slack ID to the row UUID, matching on a later page", async () => {
    mockLoadConfig.mockReturnValue(validConfig);
    const match = channel({ id: CHANNEL_B, channel_id: "C0000000B", name: "docs" });
    servePages({ items: [channel()], nextCursor: CHANNEL_A }, { items: [match], nextCursor: null });
    mockMutate.mockResolvedValueOnce(true);

    await run("slack-join", "C0000000B");

    expect(listPagedCalls()).toEqual([
      { orgId: "org1", limit: 100 },
      { orgId: "org1", limit: 100, cursor: CHANNEL_A },
    ]);
    expect(mockMutate).toHaveBeenCalledWith("slackChannel.join", CHANNEL_B);
    expect(stdout()).toContain("Joined #docs (Acme).");
  });

  it("resolves #name to an exact match on a later page", async () => {
    mockLoadConfig.mockReturnValue(validConfig);
    const exact = channel({ id: CHANNEL_B, channel_id: "C0000000B", name: "Docs" });
    servePages(
      { items: [channel({ name: "docs-archive" })], nextCursor: CHANNEL_A },
      { items: [exact], nextCursor: null },
    );
    mockMutate.mockResolvedValueOnce(true);

    await run("slack-join", "#docs");

    expect(listPagedCalls()).toEqual([
      { orgId: "org1", limit: 100, search: "docs" },
      { orgId: "org1", limit: 100, search: "docs", cursor: CHANNEL_A },
    ]);
    expect(mockMutate).toHaveBeenCalledWith("slackChannel.join", CHANNEL_B);
  });

  it("refuses a name shared across workspaces and lists the matches on stderr", async () => {
    mockLoadConfig.mockReturnValue(validConfig);
    servePages({
      items: [
        channel({ id: CHANNEL_A, name: "docs", team_name: "Acme" }),
        channel({ id: CHANNEL_B, name: "docs", team_name: "Acme EU" }),
      ],
      nextCursor: null,
    });

    await expect(run("slack-join", "docs", "--json")).rejects.toThrow("exit");

    const err = stderr();
    expect(err).toContain("2 Slack channels are named #docs");
    expect(err).toContain(CHANNEL_B);
    expect(err).toContain("Acme EU");
    expect(err).toContain("`dosu integrations slack-join <uuid>`");
    expect(stdout()).toBe("");
    expect(mockMutate).not.toHaveBeenCalled();
  });

  it("fails when nothing matches", async () => {
    mockLoadConfig.mockReturnValue(validConfig);
    servePages({ items: [channel()], nextCursor: null });

    await expect(run("slack-join", "C9999999Z")).rejects.toThrow("exit");

    expect(stderr()).toContain("No Slack channel with ID C9999999Z");
    expect(mockMutate).not.toHaveBeenCalled();
  });

  it("rejects an empty #name before any lookup", async () => {
    mockLoadConfig.mockReturnValue(validConfig);

    await expect(run("slack-join", "#")).rejects.toThrow("exit");

    expect(stderr()).toContain("<channel> must not be empty.");
    expect(listPagedCalls()).toHaveLength(0);
  });

  it("returns the input, the resolved UUID, and the channel with --json", async () => {
    mockLoadConfig.mockReturnValue(validConfig);
    const match = channel({ id: CHANNEL_B, channel_id: "C0000000B" });
    servePages({ items: [match], nextCursor: null });
    mockMutate.mockResolvedValueOnce(true);

    await run("slack-join", "C0000000B", "--json");

    expect(JSON.parse(stdout())).toEqual({
      success: true,
      channelId: "C0000000B",
      id: CHANNEL_B,
      channel: match,
    });
  });

  it("reports a null channel when a UUID was passed with --json", async () => {
    mockLoadConfig.mockReturnValue(validConfig);
    mockMutate.mockResolvedValueOnce(true);

    await run("slack-join", CHANNEL_B, "--json");

    expect(JSON.parse(stdout())).toEqual({
      success: true,
      channelId: CHANNEL_B,
      id: CHANNEL_B,
      channel: null,
    });
  });
});

describe("integrations github-collaborators", () => {
  it("lists collaborators", async () => {
    mockLoadConfig.mockReturnValue(validConfig);
    mockQuery.mockResolvedValueOnce([
      { user_name: "octocat", full_name: "Mona", email: "mona@gh.com" },
    ]);

    await run("github-collaborators", "123");

    expect(mockQuery).toHaveBeenCalledWith("githubRepository.getCollaborators", 123);

    const output = allOutput();
    expect(output).toContain("octocat");
    expect(output).toContain("Mona");
  });

  it("prints message for empty results", async () => {
    mockLoadConfig.mockReturnValue(validConfig);
    mockQuery.mockResolvedValueOnce([]);
    await run("github-collaborators", "123");
    expect(allOutput()).toContain("No collaborators found");
  });

  it("handles missing username, name, and email fields", async () => {
    mockLoadConfig.mockReturnValue(validConfig);
    mockQuery.mockResolvedValueOnce([{}]);
    await run("github-collaborators", "123");
    // All undefined fields should be replaced with "-"
    const output = allOutput();
    expect(output).toContain("-");
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

  it("propagates an error in JSON mode", async () => {
    mockLoadConfig.mockReturnValue(validConfig);
    mockQuery.mockRejectedValueOnce(new Error("fail"));

    await expect(run("status", "--json", "gitlab")).rejects.toThrow("fail");
  });
});

describe("integrations github-collaborators (JSON branch)", () => {
  it("outputs valid JSON with --json", async () => {
    mockLoadConfig.mockReturnValue(validConfig);
    mockQuery.mockResolvedValueOnce([
      { user_name: "octocat", full_name: "Mona", email: "mona@gh.com" },
    ]);

    await run("github-collaborators", "123", "--json");

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
