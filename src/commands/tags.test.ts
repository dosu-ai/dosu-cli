import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mockQuery = vi.fn();
const mockMutate = vi.fn();
vi.mock("../client/trpc", () => ({
  TrpcClient: vi.fn().mockImplementation(() => ({ query: mockQuery, mutate: mockMutate })),
}));

const mockLoadConfig = vi.fn();
vi.mock("../config/config", () => ({
  loadConfig: (...args: unknown[]) => mockLoadConfig(...args),
}));

import { tagsCommand } from "./tags";

let logSpy: ReturnType<typeof vi.spyOn>;
let errorSpy: ReturnType<typeof vi.spyOn>;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let exitSpy: any;

const validConfig = {
  access_token: "t",
  refresh_token: "r",
  expires_at: 0,
  api_key: "sk_user_test",
  space_id: "sp1",
};

function allOutput(): string {
  return logSpy.mock.calls.map((c) => c.join(" ")).join("\n");
}

async function run(...args: string[]) {
  const cmd = tagsCommand();
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

describe("tags list", () => {
  it("calls tag.listKnowledgeStoreTags with knowledge_store_id", async () => {
    mockLoadConfig.mockReturnValue(validConfig);
    mockQuery.mockResolvedValueOnce([{ id: "t1", name: "API", description: "API docs" }]);

    await run("list");

    const listCall = mockQuery.mock.calls[1]; // [0] is knowledgeStore.getBySpaceId
    expect(listCall[0]).toBe("tag.listKnowledgeStoreTags");
    expect(listCall[1]).toEqual({ knowledge_store_id: "ks1" });
  });

  it("uses pagination variant with --search", async () => {
    mockLoadConfig.mockReturnValue(validConfig);
    mockQuery.mockResolvedValueOnce([]);

    await run("list", "--search", "api");

    const listCall = mockQuery.mock.calls[1];
    expect(listCall[0]).toBe("tag.listKnowledgeStoreTagsWithPagination");
    expect(listCall[1].searchTerm).toBe("api");
  });

  it("outputs valid JSON with --json", async () => {
    mockLoadConfig.mockReturnValue(validConfig);
    mockQuery.mockResolvedValueOnce([{ id: "t1", name: "API" }]);

    await run("list", "--json");

    expect(() => JSON.parse(allOutput())).not.toThrow();
  });

  it("prints message for empty results", async () => {
    mockLoadConfig.mockReturnValue(validConfig);
    mockQuery.mockResolvedValueOnce([]);

    await run("list");

    expect(allOutput()).toContain("No tags found");
  });
});

describe("tags create", () => {
  it("calls tag.create with correct input", async () => {
    mockLoadConfig.mockReturnValue(validConfig);
    mockMutate.mockResolvedValueOnce({ id: "t1" });

    await run("create", "--name", "API", "--description", "API docs");

    expect(mockMutate).toHaveBeenCalledWith("tag.create", {
      knowledge_store_id: "ks1",
      name: "API",
      description: "API docs",
    });
  });

  it("outputs JSON with --json", async () => {
    mockLoadConfig.mockReturnValue(validConfig);
    mockMutate.mockResolvedValueOnce({ id: "t1" });

    await run("create", "--json", "--name", "API");

    expect(() => JSON.parse(allOutput())).not.toThrow();
  });

  it("prints human-readable confirmation", async () => {
    mockLoadConfig.mockReturnValue(validConfig);
    mockMutate.mockResolvedValueOnce({ id: "t1" });

    await run("create", "--name", "API");

    expect(allOutput()).toContain('Tag "API" created');
  });
});

describe("tags update", () => {
  it("calls tag.update with correct input", async () => {
    mockLoadConfig.mockReturnValue(validConfig);
    mockMutate.mockResolvedValueOnce({});

    await run("update", "t1", "--name", "Updated");

    expect(mockMutate).toHaveBeenCalledWith("tag.update", {
      id: "t1",
      knowledge_store_id: "ks1",
      name: "Updated",
      description: undefined,
    });
  });

  it("outputs JSON with --json", async () => {
    mockLoadConfig.mockReturnValue(validConfig);
    mockMutate.mockResolvedValueOnce({});

    await run("update", "--json", "t1", "--name", "Updated");

    expect(() => JSON.parse(allOutput())).not.toThrow();
  });

  it("prints human-readable confirmation", async () => {
    mockLoadConfig.mockReturnValue(validConfig);
    mockMutate.mockResolvedValueOnce({});

    await run("update", "t1", "--name", "Updated");

    expect(allOutput()).toContain("Tag updated");
  });
});

describe("tags delete", () => {
  it("calls tag.delete mutation", async () => {
    mockLoadConfig.mockReturnValue(validConfig);
    mockMutate.mockResolvedValueOnce({});

    await run("delete", "tag-id-1");

    expect(mockMutate).toHaveBeenCalledWith("tag.delete", { id: "tag-id-1" });
  });

  it("outputs JSON with --json", async () => {
    mockLoadConfig.mockReturnValue(validConfig);
    mockMutate.mockResolvedValueOnce({});

    await run("delete", "--json", "tag-id-1");

    const output = JSON.parse(allOutput());
    expect(output.success).toBe(true);
    expect(output.id).toBe("tag-id-1");
  });

  it("prints human-readable confirmation", async () => {
    mockLoadConfig.mockReturnValue(validConfig);
    mockMutate.mockResolvedValueOnce({});

    await run("delete", "tag-id-1");

    expect(allOutput()).toContain("Tag deleted");
  });
});

describe("tags add", () => {
  it("calls tag.addToPage with tag_id and page_id", async () => {
    mockLoadConfig.mockReturnValue(validConfig);
    mockMutate.mockResolvedValueOnce({});

    await run("add", "tag1", "page1");

    expect(mockMutate).toHaveBeenCalledWith("tag.addToPage", {
      tag_id: "tag1",
      page_id: "page1",
    });
  });

  it("outputs JSON with --json", async () => {
    mockLoadConfig.mockReturnValue(validConfig);
    mockMutate.mockResolvedValueOnce({});

    await run("add", "--json", "tag1", "page1");

    const output = JSON.parse(allOutput());
    expect(output.success).toBe(true);
    expect(output.tag_id).toBe("tag1");
    expect(output.page_id).toBe("page1");
  });

  it("prints human-readable confirmation", async () => {
    mockLoadConfig.mockReturnValue(validConfig);
    mockMutate.mockResolvedValueOnce({});

    await run("add", "tag1", "page1");

    expect(allOutput()).toContain("Tag added to page");
  });
});

describe("tags remove", () => {
  it("calls tag.removeFromPage", async () => {
    mockLoadConfig.mockReturnValue(validConfig);
    mockMutate.mockResolvedValueOnce({});

    await run("remove", "tag1", "page1");

    expect(mockMutate).toHaveBeenCalledWith("tag.removeFromPage", {
      tag_id: "tag1",
      page_id: "page1",
    });
  });

  it("outputs JSON with --json", async () => {
    mockLoadConfig.mockReturnValue(validConfig);
    mockMutate.mockResolvedValueOnce({});

    await run("remove", "--json", "tag1", "page1");

    const output = JSON.parse(allOutput());
    expect(output.success).toBe(true);
    expect(output.tag_id).toBe("tag1");
    expect(output.page_id).toBe("page1");
  });

  it("prints human-readable confirmation", async () => {
    mockLoadConfig.mockReturnValue(validConfig);
    mockMutate.mockResolvedValueOnce({});

    await run("remove", "tag1", "page1");

    expect(allOutput()).toContain("Tag removed from page");
  });
});

describe("tags pages", () => {
  it("calls tag.getPagesByTagId with pagination", async () => {
    mockLoadConfig.mockReturnValue(validConfig);
    mockQuery.mockResolvedValueOnce([{ id: "p1", title: "Doc A" }]);

    await run("pages", "tag1", "--limit", "5");

    const call = mockQuery.mock.calls[1];
    expect(call[0]).toBe("tag.getPagesByTagId");
    expect(call[1].tag_id).toBe("tag1");
    expect(call[1].limit).toBe(5);
  });

  it("outputs valid JSON with --json", async () => {
    mockLoadConfig.mockReturnValue(validConfig);
    mockQuery.mockResolvedValueOnce([{ id: "p1", title: "Doc A" }]);

    await run("pages", "--json", "tag1");

    expect(() => JSON.parse(allOutput())).not.toThrow();
  });

  it("prints message for empty results", async () => {
    mockLoadConfig.mockReturnValue(validConfig);
    mockQuery.mockResolvedValueOnce([]);

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
  it("exits when api_key is missing", async () => {
    mockLoadConfig.mockReturnValue({ ...validConfig, api_key: undefined });
    await expect(run("list")).rejects.toThrow("exit");
  });

  it("exits when space_id is missing", async () => {
    mockLoadConfig.mockReturnValue({ ...validConfig, space_id: undefined });
    await expect(run("list")).rejects.toThrow("exit");
  });
});
