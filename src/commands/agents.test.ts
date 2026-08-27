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
import { agentsCommand } from "./agents";

const ORG = "00000000-0000-4000-8000-000000000001";
const AGENT = "00000000-0000-4000-8000-000000000002";
const LIBRARY = "00000000-0000-4000-8000-000000000003";
const SOURCE = "00000000-0000-4000-8000-000000000004";

const validFlatConfig: FlatTestConfig = {
  access_token: "t",
  refresh_token: "r",
  expires_at: 0,
  api_key: "sk_user_test",
  org_id: ORG,
};

let logSpy: ReturnType<typeof vi.spyOn>;
// biome-ignore lint/suspicious/noExplicitAny: process.exit mock type mismatch
let exitSpy: any;

function output(): string {
  return logSpy.mock.calls.map((call: unknown[]) => call.join(" ")).join("\n");
}

async function run(...args: string[]) {
  const command = agentsCommand();
  command.exitOverride();
  await command.parseAsync(["node", "test", ...args]);
}

beforeEach(() => {
  mockQuery.mockReset();
  mockMutate.mockReset();
  mockLoadConfig.mockReturnValue(makeTestConfig(validFlatConfig));
  logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
  exitSpy = vi.spyOn(process, "exit").mockImplementation((() => {
    throw new Error("exit");
  }) as never);
});

afterEach(() => {
  logSpy.mockRestore();
  exitSpy.mockRestore();
});

describe("agents CRUD", () => {
  it("lists configurable agents", async () => {
    mockQuery.mockResolvedValueOnce([]);
    await run("list", "--json");
    expect(mockQuery).toHaveBeenCalledWith("agents.list", { org_id: ORG });
    expect(JSON.parse(output())).toEqual([]);
  });

  it("gets one agent", async () => {
    mockQuery.mockResolvedValueOnce({ deployment_id: AGENT, name: "Helper" });
    await run("info", AGENT, "--json");
    expect(mockQuery).toHaveBeenCalledWith("agents.get", AGENT);
  });

  it("rejects a non-v4 agent UUID before any request", async () => {
    await expect(run("info", "00000000-0000-1000-8000-000000000002")).rejects.toThrow();
    expect(mockQuery).not.toHaveBeenCalled();
  });

  it("creates from a source while App chooses safe defaults", async () => {
    mockMutate.mockResolvedValueOnce({ deployment_id: AGENT, name: "Helper" });
    await run("create", "--library", LIBRARY, "--source", SOURCE, "--name", "Helper", "--json");
    expect(mockMutate).toHaveBeenCalledWith("agents.create", {
      org_id: ORG,
      space_id: LIBRARY,
      data_source_id: SOURCE,
      name: "Helper",
    });
  });

  it("updates after confirmation", async () => {
    mockMutate.mockResolvedValueOnce({ deployment_id: AGENT, enabled: false });
    await run("update", AGENT, "--enabled", "off", "--confirm", "--json");
    expect(mockMutate).toHaveBeenCalledWith("agents.update", {
      deployment_id: AGENT,
      enabled: false,
    });
  });

  it("rejects an empty update locally", async () => {
    await expect(run("update", AGENT, "--confirm")).rejects.toThrow();
    expect(mockMutate).not.toHaveBeenCalled();
  });

  it("moves after confirmation", async () => {
    mockMutate.mockResolvedValueOnce({ deployment_id: AGENT, space_id: LIBRARY });
    await run("move", AGENT, "--library", LIBRARY, "--confirm", "--json");
    expect(mockMutate).toHaveBeenCalledWith("agents.move", {
      deployment_id: AGENT,
      space_id: LIBRARY,
    });
  });

  it("deletes after confirmation", async () => {
    mockMutate.mockResolvedValueOnce({ deleted: true, deployment_id: AGENT });
    await run("delete", AGENT, "--confirm", "--json");
    expect(mockMutate).toHaveBeenCalledWith("agents.delete", AGENT);
  });

  it("does not delete in non-TTY mode without confirmation", async () => {
    await run("delete", AGENT, "--json");
    expect(mockMutate).not.toHaveBeenCalled();
    expect(JSON.parse(output())).toMatchObject({ confirmRequired: true, applied: false });
  });
});

describe("agents config", () => {
  it("gets config", async () => {
    mockQuery.mockResolvedValueOnce({ deployment_id: AGENT, config: {} });
    await run("config", "get", AGENT, "--json");
    expect(mockQuery).toHaveBeenCalledWith("agents.getConfig", AGENT);
  });

  it("sets one JSON leaf with the latest version", async () => {
    mockQuery.mockResolvedValueOnce({ deployment_id: AGENT, updated_at: "v1", config: {} });
    mockMutate.mockResolvedValueOnce({ path: "issues.enabled", value: false });
    await run("config", "set", AGENT, "issues.enabled", "--value", "false", "--confirm", "--json");
    expect(mockMutate).toHaveBeenCalledWith("agents.setConfig", {
      deployment_id: AGENT,
      expected_updated_at: "v1",
      path: "issues.enabled",
      value: false,
    });
  });

  it("rejects malformed JSON before any request", async () => {
    await expect(
      run("config", "set", AGENT, "issues.enabled", "--value", "nope", "--confirm"),
    ).rejects.toThrow();
    expect(mockQuery).not.toHaveBeenCalled();
    expect(mockMutate).not.toHaveBeenCalled();
  });

  it("rejects an overlong config path before any request", async () => {
    await expect(
      run("config", "set", AGENT, "a".repeat(201), "--value", "false", "--confirm"),
    ).rejects.toThrow();
    expect(mockQuery).not.toHaveBeenCalled();
    expect(mockMutate).not.toHaveBeenCalled();
  });
});
