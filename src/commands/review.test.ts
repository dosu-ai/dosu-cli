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
};

function allOutput(): string {
  return logSpy.mock.calls.map((c) => c.join(" ")).join("\n");
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
    expect(allOutput()).toContain("Review reject");
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
    expect(allOutput()).toContain("Review revert");
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
  it("exits when api_key is missing", async () => {
    mockLoadConfig.mockReturnValue({ ...validConfig, api_key: undefined });
    await expect(run("context", "t1")).rejects.toThrow("exit");
  });
});
