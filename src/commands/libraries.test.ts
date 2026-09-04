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
import { librariesCommand } from "./libraries";

const ORG = "00000000-0000-4000-8000-000000000001";
const LIBRARY = "00000000-0000-4000-8000-000000000002";
const SOURCE = "00000000-0000-4000-8000-000000000003";

const validFlatConfig: FlatTestConfig = {
  access_token: "t",
  refresh_token: "r",
  expires_at: 0,
  api_key: "sk_user_test",
  org_id: ORG,
};

let logSpy: ReturnType<typeof vi.spyOn>;
let errorSpy: ReturnType<typeof vi.spyOn>;
// biome-ignore lint/suspicious/noExplicitAny: process.exit mock type mismatch
let exitSpy: any;

function output(): string {
  return logSpy.mock.calls.map((call: unknown[]) => call.join(" ")).join("\n");
}

async function run(...args: string[]) {
  const command = librariesCommand();
  command.exitOverride();
  await command.parseAsync(["node", "test", ...args]);
}

beforeEach(() => {
  mockQuery.mockReset();
  mockMutate.mockReset();
  mockLoadConfig.mockReturnValue(makeTestConfig(validFlatConfig));
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

describe("libraries CRUD", () => {
  it("lists the active organization", async () => {
    mockQuery.mockResolvedValueOnce([]);
    await run("list", "--json");
    expect(mockQuery).toHaveBeenCalledWith("libraries.list", ORG);
    expect(JSON.parse(output())).toEqual([]);
  });

  it("gets library info", async () => {
    mockQuery.mockResolvedValueOnce({ id: LIBRARY, name: "Docs" });
    await run("info", LIBRARY, "--json");
    expect(mockQuery).toHaveBeenCalledWith("libraries.info", LIBRARY);
  });

  it("creates a library", async () => {
    mockMutate.mockResolvedValueOnce({ id: LIBRARY, name: "Docs" });
    await run("create", "--name", "Docs", "--visibility", "private", "--json");
    expect(mockMutate).toHaveBeenCalledWith("libraries.create", {
      org_id: ORG,
      name: "Docs",
      visibility: "private",
    });
  });

  it("updates only after explicit confirmation", async () => {
    mockMutate.mockResolvedValueOnce({ id: LIBRARY, name: "New" });
    await run("update", LIBRARY, "--name", "New", "--confirm", "--json");
    expect(mockMutate).toHaveBeenCalledWith("libraries.update", { id: LIBRARY, name: "New" });
  });

  it("rejects an empty update locally", async () => {
    await expect(run("update", LIBRARY, "--confirm")).rejects.toThrow();
    expect(mockMutate).not.toHaveBeenCalled();
  });

  it("does not delete in non-TTY mode without --confirm", async () => {
    await run("delete", LIBRARY, "--json");
    expect(mockMutate).not.toHaveBeenCalled();
    expect(JSON.parse(output())).toMatchObject({ confirmRequired: true, applied: false });
  });

  it("deletes with --confirm", async () => {
    mockMutate.mockResolvedValueOnce({ deleted: true, id: LIBRARY });
    await run("delete", LIBRARY, "--confirm", "--json");
    expect(mockMutate).toHaveBeenCalledWith("libraries.delete", LIBRARY);
  });
});

describe("libraries config", () => {
  it("gets documentation config", async () => {
    mockQuery.mockResolvedValueOnce({ config: { review_timeout_days: 14 } });
    await run("config", "get", LIBRARY, "--json");
    expect(mockQuery).toHaveBeenCalledWith("libraries.configGet", LIBRARY);
  });

  it("sets one validated config value with optimistic concurrency", async () => {
    mockQuery.mockResolvedValueOnce({ updated_at: "v1", config: { review_timeout_days: 14 } });
    mockMutate.mockResolvedValueOnce({ setting: "review_timeout_days", value: 30 });
    await run(
      "config",
      "set",
      LIBRARY,
      "review_timeout_days",
      "--value",
      "30",
      "--confirm",
      "--json",
    );
    expect(mockMutate).toHaveBeenCalledWith("libraries.configSet", {
      expected_updated_at: "v1",
      setting: "review_timeout_days",
      space_id: LIBRARY,
      value: 30,
    });
  });

  it("rejects an invalid config value before any request", async () => {
    await expect(
      run("config", "set", LIBRARY, "review_timeout_days", "--value", '"thirty"', "--confirm"),
    ).rejects.toThrow();
    expect(mockQuery).not.toHaveBeenCalled();
    expect(mockMutate).not.toHaveBeenCalled();
  });

  it("rejects a review timeout outside the App choices before any request", async () => {
    await expect(
      run("config", "set", LIBRARY, "review_timeout_days", "--value", "17", "--confirm"),
    ).rejects.toThrow();
    expect(mockQuery).not.toHaveBeenCalled();
    expect(mockMutate).not.toHaveBeenCalled();
  });

  it("rejects the removed default save-publish setting before any request", async () => {
    await expect(
      run("config", "set", LIBRARY, "default_save_publish", "--value", "true", "--confirm"),
    ).rejects.toThrow();
    expect(mockQuery).not.toHaveBeenCalled();
    expect(mockMutate).not.toHaveBeenCalled();
  });
});

describe("libraries sources", () => {
  it("lists attached sources", async () => {
    mockQuery.mockResolvedValueOnce([]);
    await run("sources", "list", LIBRARY, "--json");
    expect(mockQuery).toHaveBeenCalledWith("libraries.sourcesList", LIBRARY);
  });

  it("attaches one or more sources after confirmation", async () => {
    mockMutate.mockResolvedValueOnce(1);
    await run("sources", "attach", LIBRARY, SOURCE, "--confirm", "--json");
    expect(mockMutate).toHaveBeenCalledWith("libraries.sourcesAttach", {
      space_id: LIBRARY,
      data_source_ids: [SOURCE],
    });
  });

  it("detaches one or more sources after confirmation", async () => {
    mockMutate.mockResolvedValueOnce(1);
    await run("sources", "detach", LIBRARY, SOURCE, "--confirm", "--json");
    expect(mockMutate).toHaveBeenCalledWith("libraries.sourcesDetach", {
      space_id: LIBRARY,
      data_source_ids: [SOURCE],
    });
  });

  it("rejects invalid source ids locally", async () => {
    await expect(
      run("sources", "attach", LIBRARY, "00000000-0000-1000-8000-000000000003", "--confirm"),
    ).rejects.toThrow();
    expect(mockMutate).not.toHaveBeenCalled();
  });

  it("gets source config without choosing the provider in the CLI", async () => {
    mockQuery.mockResolvedValueOnce({ provider_slug: "github" });
    await run("sources", "config", "get", LIBRARY, SOURCE, "--json");
    expect(mockQuery).toHaveBeenCalledWith("libraries.sourceConfigGet", {
      space_id: LIBRARY,
      data_source_id: SOURCE,
    });
  });

  it("updates source config without choosing the provider in the CLI", async () => {
    mockMutate.mockResolvedValueOnce({ provider_slug: "github", issues_enabled: false });
    await run(
      "sources",
      "config",
      "update",
      LIBRARY,
      SOURCE,
      "--issues",
      "off",
      "--include-patterns",
      '["docs/**"]',
      "--confirm",
      "--json",
    );
    expect(mockMutate).toHaveBeenCalledWith("libraries.sourceConfigUpdate", {
      space_id: LIBRARY,
      data_source_id: SOURCE,
      issues_enabled: false,
      included_file_patterns: ["docs/**"],
    });
  });

  it("rejects a source config update with no fields", async () => {
    await expect(
      run("sources", "config", "update", LIBRARY, SOURCE, "--confirm"),
    ).rejects.toThrow();
    expect(mockMutate).not.toHaveBeenCalled();
  });
});

describe("libraries monitors", () => {
  it("lists Monitor settings by source", async () => {
    mockQuery.mockResolvedValueOnce([]);
    await run("monitors", "list", LIBRARY, "--json");
    expect(mockQuery).toHaveBeenCalledWith("libraries.monitorsList", LIBRARY);
  });

  it("updates Monitor settings by source", async () => {
    mockMutate.mockResolvedValueOnce({ data_source_id: SOURCE, enabled: true });
    await run(
      "monitors",
      "update",
      LIBRARY,
      SOURCE,
      "--enabled",
      "on",
      "--paths",
      '["docs/**"]',
      "--up-to-date-behavior",
      "comment",
      "--confirm",
      "--json",
    );
    expect(mockMutate).toHaveBeenCalledWith("libraries.monitorsUpdate", {
      space_id: LIBRARY,
      data_source_id: SOURCE,
      enabled: true,
      monitored_paths: ["docs/**"],
      no_update_behavior: "comment",
    });
  });

  it("rejects a Monitor update with no fields before any request", async () => {
    await expect(run("monitors", "update", LIBRARY, SOURCE, "--confirm")).rejects.toThrow();
    expect(mockMutate).not.toHaveBeenCalled();
  });
});
