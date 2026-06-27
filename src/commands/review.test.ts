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

import { reviewCommand } from "./review";

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
  const cmd = reviewCommand();
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

describe("review list", () => {
  const pendingItem = {
    pageVersionId: "pv-abcdef12",
    pageId: "pg-1",
    title: "API Guide",
    version: 3,
    type: "document",
    origin: "sync_upstream",
    externalTriggerUrl: "https://github.com/org/repo/pull/42",
    pendingStatus: "pending_review",
    createdAt: "2026-06-24T19:18:50.002Z",
  };

  it("resolves space→KS then calls review.listPending", async () => {
    mockLoadConfig.mockReturnValue(validConfig);
    mockQuery.mockResolvedValueOnce({ id: "ks1" }); // knowledgeStore.getBySpaceId
    mockQuery.mockResolvedValueOnce([pendingItem]);

    await run("list");

    expect(mockQuery).toHaveBeenNthCalledWith(1, "knowledgeStore.getBySpaceId", {
      space_id: "sp1",
    });
    expect(mockQuery).toHaveBeenNthCalledWith(2, "review.listPending", {
      knowledgeStoreId: "ks1",
    });
    expect(allOutput()).toContain("pv-abcde");
    expect(allOutput()).toContain("API Guide");
  });

  it("outputs valid JSON with --json", async () => {
    mockLoadConfig.mockReturnValue(validConfig);
    mockQuery.mockResolvedValueOnce({ id: "ks1" });
    mockQuery.mockResolvedValueOnce([pendingItem]);

    await run("list", "--json");

    const output = JSON.parse(allOutput());
    expect(output).toHaveLength(1);
    expect(output[0].pageVersionId).toBe("pv-abcdef12");
  });

  it("prints message for empty queue", async () => {
    mockLoadConfig.mockReturnValue(validConfig);
    mockQuery.mockResolvedValueOnce({ id: "ks1" });
    mockQuery.mockResolvedValueOnce([]);

    await run("list");

    expect(allOutput()).toContain("No pending review items");
  });

  it("exits when space_id is missing", async () => {
    mockLoadConfig.mockReturnValue({ ...validConfig, space_id: undefined });
    await expect(run("list")).rejects.toThrow("exit");
  });

  it("exits when no knowledge store is found", async () => {
    mockLoadConfig.mockReturnValue(validConfig);
    mockQuery.mockResolvedValueOnce(null); // knowledgeStore.getBySpaceId
    await expect(run("list")).rejects.toThrow("exit");
  });
});

describe("review context", () => {
  it("calls review.getThreadContext with thread_id", async () => {
    mockLoadConfig.mockReturnValue(validConfig);
    mockQuery.mockResolvedValueOnce({ type: "messages" });

    await run("context", "thread-1");

    expect(mockQuery).toHaveBeenCalledWith("review.getThreadContext", {
      thread_id: "thread-1",
    });
  });

  it("outputs valid JSON with --json", async () => {
    mockLoadConfig.mockReturnValue(validConfig);
    mockQuery.mockResolvedValueOnce({
      type: "document",
      reviewPage: { id: "p1", title: "Doc" },
    });

    await run("context", "--json", "thread-1");

    const output = JSON.parse(allOutput());
    expect(output.type).toBe("document");
  });

  it("displays document type with review page info", async () => {
    mockLoadConfig.mockReturnValue(validConfig);
    mockQuery.mockResolvedValueOnce({
      type: "document",
      reviewPage: { id: "p1", title: "API Guide" },
      syncPrUrl: "https://github.com/org/repo/pull/42",
    });

    await run("context", "thread-1");

    const output = allOutput();
    expect(output).toContain("document");
    expect(output).toContain("API Guide");
    expect(output).toContain("github.com");
  });

  it("displays published page ID when title is missing", async () => {
    mockLoadConfig.mockReturnValue(validConfig);
    mockQuery.mockResolvedValueOnce({
      type: "document",
      reviewPage: { id: "p1" },
      publishedPage: { id: "pub-p1" },
      syncPrUrl: null,
    });

    await run("context", "thread-1");

    const output = allOutput();
    expect(output).toContain("pub-p1");
  });

  it("displays null publishedPage and no syncPrUrl", async () => {
    mockLoadConfig.mockReturnValue(validConfig);
    mockQuery.mockResolvedValueOnce({
      type: "messages",
      reviewPage: { id: "p1" },
      publishedPage: null,
      syncPrUrl: undefined,
    });

    await run("context", "thread-1");

    const output = allOutput();
    expect(output).toContain("messages");
    expect(output).toContain("p1");
    expect(output).not.toContain("Published Page");
    expect(output).not.toContain("Sync PR");
  });
});

describe("review approve", () => {
  it("calls page.updatePublicationStatus with action=accept", async () => {
    mockLoadConfig.mockReturnValue(validConfig);
    mockMutate.mockResolvedValueOnce({});

    await run("approve", "pv-1");

    expect(mockMutate).toHaveBeenCalledWith("page.updatePublicationStatus", {
      page_version_id: "pv-1",
      action: "accept",
    });
  });

  it("outputs JSON with --json", async () => {
    mockLoadConfig.mockReturnValue(validConfig);
    mockMutate.mockResolvedValueOnce({});

    await run("approve", "--json", "pv-1");

    const output = JSON.parse(allOutput());
    expect(output.success).toBe(true);
    expect(output.action).toBe("accept");
  });
});

describe("review reject", () => {
  it("calls page.updatePublicationStatus with action=decline", async () => {
    mockLoadConfig.mockReturnValue(validConfig);
    mockMutate.mockResolvedValueOnce({});

    await run("reject", "pv-1");

    expect(mockMutate).toHaveBeenCalledWith("page.updatePublicationStatus", {
      page_version_id: "pv-1",
      action: "decline",
    });
  });

  it("prints human-readable confirmation", async () => {
    mockLoadConfig.mockReturnValue(validConfig);
    mockMutate.mockResolvedValueOnce({});
    await run("reject", "pv-123456");
    expect(allOutput()).toContain("Review reject: pv-12345");
  });
});

describe("review revert", () => {
  it("calls page.updatePublicationStatus with action=revert_to_pending", async () => {
    mockLoadConfig.mockReturnValue(validConfig);
    mockMutate.mockResolvedValueOnce({});

    await run("revert", "pv-1");

    expect(mockMutate).toHaveBeenCalledWith("page.updatePublicationStatus", {
      page_version_id: "pv-1",
      action: "revert_to_pending",
    });
  });

  it("prints human-readable confirmation", async () => {
    mockLoadConfig.mockReturnValue(validConfig);
    mockMutate.mockResolvedValueOnce({});
    await run("revert", "pv-123456");
    expect(allOutput()).toContain("Review revert: pv-12345");
  });

  it("outputs JSON with --json", async () => {
    mockLoadConfig.mockReturnValue(validConfig);
    mockMutate.mockResolvedValueOnce({});
    await run("revert", "--json", "pv-1");
    const output = JSON.parse(allOutput());
    expect(output.success).toBe(true);
    expect(output.action).toBe("revert_to_pending");
  });
});

describe("requireConfig", () => {
  it("exits when access_token is missing", async () => {
    mockLoadConfig.mockReturnValue({ ...validConfig, access_token: "" });
    await expect(run("context", "t1")).rejects.toThrow("exit");
  });
});
