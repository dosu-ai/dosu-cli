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

const mockConfirm = vi.fn();
vi.mock("@clack/prompts", () => ({
  confirm: (...args: unknown[]) => mockConfirm(...args),
  isCancel: (value: unknown) => value === Symbol.for("clack:cancel"),
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
    id: "pv-abcdef12",
    kind: "doc_change",
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
    expect(allOutput()).toContain("doc_change");
    expect(allOutput()).toContain("API Guide");
    // origin enum is humanized to match the MCP tool / dashboard
    expect(allOutput()).toContain("Synced from source");
    expect(allOutput()).not.toContain("sync_upstream");
  });

  it("outputs valid JSON with --json", async () => {
    mockLoadConfig.mockReturnValue(validConfig);
    mockQuery.mockResolvedValueOnce({ id: "ks1" });
    mockQuery.mockResolvedValueOnce([pendingItem]);

    await run("list", "--json");

    const output = JSON.parse(allOutput());
    expect(output).toHaveLength(1);
    expect(output[0].id).toBe("pv-abcdef12");
    expect(output[0].kind).toBe("doc_change");
    // --json is the machine surface — raw enum, not humanized
    expect(output[0].origin).toBe("sync_upstream");
  });

  it.each([
    ["manual_update", 1, "User created"],
    ["manual_update", 2, "User updated"],
    ["llm_generated", 1, "AI generated"],
    ["api_update", 1, "Created via API"],
    ["future_origin", 1, "future_origin"], // unknown enum falls through to raw value
  ])("humanizes source %s (v%i) as %s", async (origin, version, expected) => {
    mockLoadConfig.mockReturnValue(validConfig);
    mockQuery.mockResolvedValueOnce({ id: "ks1" });
    mockQuery.mockResolvedValueOnce([{ ...pendingItem, origin, version }]);

    await run("list");

    expect(allOutput()).toContain(expected);
  });

  it("falls back to (untitled) when title is missing", async () => {
    mockLoadConfig.mockReturnValue(validConfig);
    mockQuery.mockResolvedValueOnce({ id: "ks1" });
    mockQuery.mockResolvedValueOnce([{ ...pendingItem, title: null }]);

    await run("list");

    expect(allOutput()).toContain("(untitled)");
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

const changeView = {
  id: "pv-1",
  kind: "doc_change",
  title: "API Guide",
  source: "Synced from source",
  version: 3,
  publishedVersion: 2,
  isNewDoc: false,
  hasChanges: true,
  diff: "@@ -1,2 +1,2 @@\n context line\n-old line\n+new line",
};

describe("review approve", () => {
  it("previews the diff and applies with --confirm", async () => {
    mockLoadConfig.mockReturnValue(validConfig);
    mockQuery.mockResolvedValueOnce(changeView); // review.getChange
    mockMutate.mockResolvedValueOnce({});

    await run("approve", "--confirm", "pv-1");

    expect(mockQuery).toHaveBeenCalledWith("review.getChange", { id: "pv-1" });
    expect(mockMutate).toHaveBeenCalledWith("page.updatePublicationStatus", {
      page_version_id: "pv-1",
      action: "accept",
    });
    // the diff preview is shown before applying
    const out = allOutput();
    expect(out).toContain("API Guide");
    expect(out).toContain("new line");
    expect(out).toContain("Review approve: pv-1");
  });

  it("does not mutate without --confirm in non-interactive mode", async () => {
    mockLoadConfig.mockReturnValue(validConfig);
    mockQuery.mockResolvedValueOnce(changeView);

    await run("approve", "pv-1");

    expect(mockMutate).not.toHaveBeenCalled();
    expect(allOutput()).toContain("Re-run with --confirm");
  });

  it("outputs JSON with --json --confirm", async () => {
    mockLoadConfig.mockReturnValue(validConfig);
    mockQuery.mockResolvedValueOnce(changeView);
    mockMutate.mockResolvedValueOnce({});

    await run("approve", "--json", "--confirm", "pv-1");

    const output = JSON.parse(allOutput());
    expect(output.success).toBe(true);
    expect(output.id).toBe("pv-1");
    expect(output.action).toBe("accept");
  });

  it("returns the change preview as JSON without --confirm and does not mutate", async () => {
    mockLoadConfig.mockReturnValue(validConfig);
    mockQuery.mockResolvedValueOnce(changeView);

    await run("approve", "--json", "pv-1");

    const output = JSON.parse(allOutput());
    expect(output.confirmRequired).toBe(true);
    expect(output.applied).toBe(false);
    expect(output.diff).toContain("new line");
    expect(mockMutate).not.toHaveBeenCalled();
  });
});

describe("review reject", () => {
  it("applies with --confirm", async () => {
    mockLoadConfig.mockReturnValue(validConfig);
    mockQuery.mockResolvedValueOnce(changeView);
    mockMutate.mockResolvedValueOnce({});

    await run("reject", "--confirm", "pv-123456");

    expect(mockMutate).toHaveBeenCalledWith("page.updatePublicationStatus", {
      page_version_id: "pv-123456",
      action: "decline",
    });
    expect(allOutput()).toContain("Review reject: pv-12345");
  });

  it("shows 'No content changes' when hasChanges is false", async () => {
    mockLoadConfig.mockReturnValue(validConfig);
    mockQuery.mockResolvedValueOnce({ ...changeView, hasChanges: false });

    await run("reject", "pv-1");

    expect(allOutput()).toContain("No content changes");
    expect(mockMutate).not.toHaveBeenCalled();
  });
});

describe("review approve (interactive prompt)", () => {
  let ttyDescriptor: PropertyDescriptor | undefined;

  beforeEach(() => {
    ttyDescriptor = Object.getOwnPropertyDescriptor(process.stdin, "isTTY");
    Object.defineProperty(process.stdin, "isTTY", { value: true, configurable: true });
  });

  afterEach(() => {
    if (ttyDescriptor) {
      Object.defineProperty(process.stdin, "isTTY", ttyDescriptor);
    } else {
      // restore the original "absent" state so later tests stay non-interactive
      Object.defineProperty(process.stdin, "isTTY", { value: undefined, configurable: true });
    }
  });

  it("applies when the user confirms y/N", async () => {
    mockLoadConfig.mockReturnValue(validConfig);
    mockQuery.mockResolvedValueOnce(changeView);
    mockMutate.mockResolvedValueOnce({});
    mockConfirm.mockResolvedValueOnce(true);

    await run("approve", "pv-1");

    expect(mockConfirm).toHaveBeenCalled();
    expect(mockMutate).toHaveBeenCalledWith("page.updatePublicationStatus", {
      page_version_id: "pv-1",
      action: "accept",
    });
  });

  it("aborts when the user declines", async () => {
    mockLoadConfig.mockReturnValue(validConfig);
    mockQuery.mockResolvedValueOnce(changeView);
    mockConfirm.mockResolvedValueOnce(false);

    await run("approve", "pv-1");

    expect(mockMutate).not.toHaveBeenCalled();
    expect(allOutput()).toContain("Aborted");
  });

  it("handles cancellation gracefully", async () => {
    mockLoadConfig.mockReturnValue(validConfig);
    mockQuery.mockResolvedValueOnce(changeView);
    mockConfirm.mockResolvedValueOnce(Symbol.for("clack:cancel"));

    await run("approve", "pv-1");

    expect(mockMutate).not.toHaveBeenCalled();
    expect(allOutput()).toContain("Cancelled");
  });

  it("renders a new-doc preview (no published version)", async () => {
    mockLoadConfig.mockReturnValue(validConfig);
    mockQuery.mockResolvedValueOnce({
      ...changeView,
      isNewDoc: true,
      publishedVersion: null,
      version: 1,
    });
    mockConfirm.mockResolvedValueOnce(false);

    await run("approve", "pv-1");

    expect(allOutput()).toContain("1 (new)");
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
