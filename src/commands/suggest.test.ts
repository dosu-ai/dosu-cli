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

import { suggestCommand } from "./suggest";

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
  org_id: "org1",
};

function allOutput(): string {
  return logSpy.mock.calls.map((c) => c.join(" ")).join("\n");
}

async function run(...args: string[]) {
  const cmd = suggestCommand();
  cmd.exitOverride();
  await cmd.parseAsync(["node", "test", ...args]);
}

beforeEach(() => {
  mockQuery.mockReset();
  mockMutate.mockReset();
  mockLoadConfig.mockReset();
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

describe("suggest list", () => {
  it("calls suggestedDoc.listForKnowledgeStore", async () => {
    mockLoadConfig.mockReturnValue(validConfig);
    mockQuery.mockResolvedValueOnce([{ id: "s1", title: "API Overview" }]);

    await run("list");

    const call = mockQuery.mock.calls[1];
    expect(call[0]).toBe("suggestedDoc.listForKnowledgeStore");
    expect(call[1].knowledgeStoreId).toBe("ks1");
  });

  it("outputs valid JSON with --json", async () => {
    mockLoadConfig.mockReturnValue(validConfig);
    mockQuery.mockResolvedValueOnce([{ id: "s1" }]);
    await run("list", "--json");
    expect(() => JSON.parse(allOutput())).not.toThrow();
  });

  it("prints message for empty suggestions", async () => {
    mockLoadConfig.mockReturnValue(validConfig);
    mockQuery.mockResolvedValueOnce([]);
    await run("list");
    expect(allOutput()).toContain("No pending suggestions");
  });
});

describe("suggest generate", () => {
  it("fetches data sources then calls suggestedDoc.generate", async () => {
    mockLoadConfig.mockReturnValue(validConfig);
    mockQuery.mockResolvedValueOnce([{ id: "ds1" }, { id: "ds2" }]); // dataSource.list
    mockMutate.mockResolvedValueOnce({});

    await run("generate");

    expect(mockMutate).toHaveBeenCalledWith("suggestedDoc.generate", {
      knowledgeStoreId: "ks1",
      dataSourceIds: ["ds1", "ds2"],
    });
  });

  it("outputs JSON with --json", async () => {
    mockLoadConfig.mockReturnValue(validConfig);
    mockQuery.mockResolvedValueOnce([{ id: "ds1" }]);
    mockMutate.mockResolvedValueOnce({ status: "generating" });

    await run("generate", "--json");

    expect(() => JSON.parse(allOutput())).not.toThrow();
  });

  it("prints human-readable confirmation", async () => {
    mockLoadConfig.mockReturnValue(validConfig);
    mockQuery.mockResolvedValueOnce([{ id: "ds1" }]);
    mockMutate.mockResolvedValueOnce({});

    await run("generate");

    expect(allOutput()).toContain("Document suggestions are being generated");
  });
});

describe("suggest accept", () => {
  it("calls suggestedDoc.generateDocBySuggestedDocId with options", async () => {
    mockLoadConfig.mockReturnValue(validConfig);
    mockMutate.mockResolvedValueOnce({});

    await run("accept", "s1", "--title", "Custom Title", "--instructions", "Focus on API");

    expect(mockMutate).toHaveBeenCalledWith("suggestedDoc.generateDocBySuggestedDocId", {
      knowledgeStoreId: "ks1",
      suggestedDocId: "s1",
      title: "Custom Title",
      instructions: "Focus on API",
    });
  });

  it("outputs JSON with --json", async () => {
    mockLoadConfig.mockReturnValue(validConfig);
    mockMutate.mockResolvedValueOnce({ page_id: "p1" });
    await run("accept", "--json", "s1");
    expect(() => JSON.parse(allOutput())).not.toThrow();
  });
});

describe("suggest reject", () => {
  it("calls suggestedDoc.delete mutation", async () => {
    mockLoadConfig.mockReturnValue(validConfig);
    mockMutate.mockResolvedValueOnce({});

    await run("reject", "s1");

    expect(mockMutate).toHaveBeenCalledWith("suggestedDoc.delete", { id: "s1" });
  });

  it("outputs JSON with --json", async () => {
    mockLoadConfig.mockReturnValue(validConfig);
    mockMutate.mockResolvedValueOnce({});

    await run("reject", "--json", "s1");

    const output = JSON.parse(allOutput());
    expect(output.success).toBe(true);
    expect(output.id).toBe("s1");
  });

  it("prints human-readable confirmation", async () => {
    mockLoadConfig.mockReturnValue(validConfig);
    mockMutate.mockResolvedValueOnce({});

    await run("reject", "s1");

    expect(allOutput()).toContain("Suggestion rejected");
  });
});

describe("suggest accept (human-readable)", () => {
  it("prints human-readable confirmation", async () => {
    mockLoadConfig.mockReturnValue(validConfig);
    mockMutate.mockResolvedValueOnce({});

    await run("accept", "s1");

    expect(allOutput()).toContain("Document created from suggestion");
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
  it("exits when space_id is missing", async () => {
    mockLoadConfig.mockReturnValue({ ...validConfig, space_id: undefined });
    await expect(run("list")).rejects.toThrow("exit");
  });

  it("exits when api_key is missing", async () => {
    mockLoadConfig.mockReturnValue({ ...validConfig, api_key: undefined });
    await expect(run("list")).rejects.toThrow("exit");
  });
});
