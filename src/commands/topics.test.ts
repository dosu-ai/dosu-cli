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

import { topicsCommand } from "./topics";

let logSpy: ReturnType<typeof vi.spyOn>;
let errorSpy: ReturnType<typeof vi.spyOn>;
// biome-ignore lint/suspicious/noExplicitAny: process.exit mock type mismatch
let exitSpy: any;

const validConfig = {
  access_token: "t",
  refresh_token: "r",
  expires_at: 0,
  api_key: "sk_user_test",
  space_id: "sp1",
};

function allOutput(): string {
  return logSpy.mock.calls.map((c: unknown[]) => c.join(" ")).join("\n");
}

async function run(...args: string[]) {
  const cmd = topicsCommand();
  cmd.exitOverride();
  await cmd.parseAsync(["node", "test", ...args]);
}

beforeEach(() => {
  mockQuery.mockReset();
  mockMutate.mockReset();
  mockLoadConfig.mockReset();
  // getKnowledgeStoreId is called first in most commands
  mockQuery.mockResolvedValueOnce({ id: "ks1" }); // knowledgeStore.getBySpaceId
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

describe("topics list", () => {
  it("calls topic.listTopicsByKnowledgeStore with knowledge_store_id", async () => {
    mockLoadConfig.mockReturnValue(validConfig);
    mockQuery.mockResolvedValueOnce([{ topic_id: "t1", name: "API", description: "API docs" }]);

    await run("list");

    const listCall = mockQuery.mock.calls[1]; // [0] is knowledgeStore.getBySpaceId
    expect(listCall[0]).toBe("topic.listTopicsByKnowledgeStore");
    expect(listCall[1]).toEqual({ knowledge_store_id: "ks1" });
  });

  it("outputs valid JSON with --json", async () => {
    mockLoadConfig.mockReturnValue(validConfig);
    mockQuery.mockResolvedValueOnce([{ topic_id: "t1", name: "API" }]);

    await run("list", "--json");

    const output = JSON.parse(allOutput());
    expect(output).toHaveLength(1);
    expect(output[0]).toMatchObject({ topic_id: "t1", name: "API" });
  });

  it("prints message for empty results", async () => {
    mockLoadConfig.mockReturnValue(validConfig);
    mockQuery.mockResolvedValueOnce([]);

    await run("list");

    expect(allOutput()).toContain("No topics found");
  });
});

describe("topics pages", () => {
  it("calls topic.getPagesByTopicId with pagination", async () => {
    mockLoadConfig.mockReturnValue(validConfig);
    mockQuery.mockResolvedValueOnce({ data: [{ id: "p1", title: "Doc A" }] });

    await run("pages", "tag1", "--limit", "5");

    const call = mockQuery.mock.calls[1];
    expect(call[0]).toBe("topic.getPagesByTopicId");
    expect(call[1].topic_id).toBe("tag1");
    expect(call[1].limit).toBe(5);
  });

  it("outputs valid JSON with --json", async () => {
    mockLoadConfig.mockReturnValue(validConfig);
    mockQuery.mockResolvedValueOnce({ data: [{ id: "p1", title: "Doc A" }] });

    await run("pages", "--json", "tag1");

    const output = JSON.parse(allOutput());
    expect(output).toHaveLength(1);
    expect(output[0]).toMatchObject({ id: "p1", title: "Doc A" });
  });

  it("prints message for empty results", async () => {
    mockLoadConfig.mockReturnValue(validConfig);
    mockQuery.mockResolvedValueOnce({ data: [] });

    await run("pages", "tag1");

    expect(allOutput()).toContain("No pages found");
  });
});

describe("getKnowledgeStoreId", () => {
  it("exits when no knowledge store is found", async () => {
    mockLoadConfig.mockReturnValue(validConfig);
    mockQuery.mockReset();
    mockQuery.mockResolvedValueOnce(null); // knowledgeStore.getBySpaceId returns null
    await expect(run("list")).rejects.toThrow("exit");
  });
});

describe("requireConfig", () => {
  it("exits when access_token is missing", async () => {
    mockLoadConfig.mockReturnValue({ ...validConfig, access_token: "" });
    await expect(run("list")).rejects.toThrow("exit");
  });

  it("exits when space_id is missing", async () => {
    mockLoadConfig.mockReturnValue({ ...validConfig, space_id: undefined });
    await expect(run("list")).rejects.toThrow("exit");
  });
});
