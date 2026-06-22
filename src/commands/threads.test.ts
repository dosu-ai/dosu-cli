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

import { threadsCommand } from "./threads";

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
  const cmd = threadsCommand();
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

describe("threads list", () => {
  it("uses space_id from config and default limit of 20", async () => {
    mockLoadConfig.mockReturnValue(validConfig);
    mockQuery.mockResolvedValueOnce({ list: [], pageInfo: {} });
    await run("list");

    const [proc, input] = mockQuery.mock.calls[0];
    expect(proc).toBe("thread.list");
    expect(input.space_id).toBe("sp1");
    expect(input.limit).toBe(20);
  });

  it("sets resolved=true for --status resolved", async () => {
    mockLoadConfig.mockReturnValue(validConfig);
    mockQuery.mockResolvedValueOnce({ list: [], pageInfo: {} });
    await run("list", "--status", "resolved");
    expect(mockQuery.mock.calls[0][1].resolved).toBe(true);
  });

  it("sets archived=true for --status archived", async () => {
    mockLoadConfig.mockReturnValue(validConfig);
    mockQuery.mockResolvedValueOnce({ list: [], pageInfo: {} });
    await run("list", "--status", "archived");
    expect(mockQuery.mock.calls[0][1].archived).toBe(true);
  });

  it("sets resolved=false and archived=false for --status pending", async () => {
    mockLoadConfig.mockReturnValue(validConfig);
    mockQuery.mockResolvedValueOnce({ list: [], pageInfo: {} });
    await run("list", "--status", "pending");
    const input = mockQuery.mock.calls[0][1];
    expect(input.resolved).toBe(false);
    expect(input.archived).toBe(false);
  });

  it("does not set resolved/archived when no --status", async () => {
    mockLoadConfig.mockReturnValue(validConfig);
    mockQuery.mockResolvedValueOnce({ list: [], pageInfo: {} });
    await run("list");
    const input = mockQuery.mock.calls[0][1];
    expect(input.resolved).toBeUndefined();
    expect(input.archived).toBeUndefined();
  });

  it("passes search parameter with --search", async () => {
    mockLoadConfig.mockReturnValue(validConfig);
    mockQuery.mockResolvedValueOnce({ list: [], pageInfo: {} });
    await run("list", "--search", "bug fix");
    expect(mockQuery.mock.calls[0][1].search).toBe("bug fix");
  });

  it("caps --limit at 100", async () => {
    mockLoadConfig.mockReturnValue(validConfig);
    mockQuery.mockResolvedValueOnce({ list: [], pageInfo: {} });
    await run("list", "--limit", "200");
    expect(mockQuery.mock.calls[0][1].limit).toBe(100);
  });

  it("outputs valid JSON with --json", async () => {
    mockLoadConfig.mockReturnValue(validConfig);
    mockQuery.mockResolvedValueOnce({
      list: [{ id: "t1", generated_title: "Bug" }],
      pageInfo: {},
    });
    await run("list", "--json");
    const output = JSON.parse(allOutput());
    expect(output.list).toHaveLength(1);
    expect(output.list[0]).toMatchObject({ id: "t1", generated_title: "Bug" });
  });

  it("prints 'No threads found.' for empty results", async () => {
    mockLoadConfig.mockReturnValue(validConfig);
    mockQuery.mockResolvedValueOnce({ list: [], pageInfo: {} });
    await run("list");
    expect(allOutput()).toContain("No threads found");
  });

  it("shows 'resolved' status when resolved is true", async () => {
    mockLoadConfig.mockReturnValue(validConfig);
    mockQuery.mockResolvedValueOnce({
      list: [{ id: "t1", generated_title: "Done", resolved: true, created_at: "2024-01-01" }],
      pageInfo: {},
    });
    await run("list");
    expect(allOutput()).toContain("resolved");
  });

  it("shows 'archived' status when only inbox_archived_at is set", async () => {
    mockLoadConfig.mockReturnValue(validConfig);
    mockQuery.mockResolvedValueOnce({
      list: [
        {
          id: "t2",
          generated_title: "Old",
          resolved: false,
          inbox_archived_at: "2024-01-01",
          created_at: "2024-01-01",
        },
      ],
      pageInfo: {},
    });
    await run("list");
    expect(allOutput()).toContain("archived");
  });

  it("shows 'pending' status when neither resolved nor archived", async () => {
    mockLoadConfig.mockReturnValue(validConfig);
    mockQuery.mockResolvedValueOnce({
      list: [{ id: "t3", generated_title: "Open", created_at: "2024-01-01" }],
      pageInfo: {},
    });
    await run("list");
    expect(allOutput()).toContain("pending");
  });

  it("uses initial_message_title as fallback when generated_title is missing", async () => {
    mockLoadConfig.mockReturnValue(validConfig);
    mockQuery.mockResolvedValueOnce({
      list: [{ id: "t4", initial_message_title: "Some preview text", created_at: "2024-01-01" }],
      pageInfo: {},
    });
    await run("list");
    expect(allOutput()).toContain("Some preview");
  });

  it("shows '(no title)' when both generated_title and initial_message_title are missing", async () => {
    mockLoadConfig.mockReturnValue(validConfig);
    mockQuery.mockResolvedValueOnce({
      list: [{ id: "t5", created_at: "2024-01-01" }],
      pageInfo: {},
    });
    await run("list");
    expect(allOutput()).toContain("(no title)");
  });
});

describe("threads get", () => {
  it("calls thread.get and messages.list, outputs JSON with both keys", async () => {
    mockLoadConfig.mockReturnValue(validConfig);
    mockQuery
      .mockResolvedValueOnce({ id: "t1", generated_title: "Bug Report" })
      .mockResolvedValueOnce({
        list: [{ messages: [{ id: "m1", body: "Hello", author_role: "user" }] }],
      });

    await run("get", "--json", "t1");

    const output = JSON.parse(allOutput());
    expect(output).toHaveProperty("thread");
    expect(output).toHaveProperty("messages");
    expect(output.thread.id).toBe("t1");
  });
});

describe("threads archive", () => {
  it("calls mutate (not query) with thread.archive", async () => {
    mockLoadConfig.mockReturnValue(validConfig);
    mockMutate.mockResolvedValueOnce({});

    await run("archive", "t1");

    expect(mockMutate).toHaveBeenCalledWith("thread.archive", { threadId: "t1", archived: true });
    expect(mockQuery).not.toHaveBeenCalledWith("thread.archive", expect.anything());
  });

  it("outputs JSON with success and id", async () => {
    mockLoadConfig.mockReturnValue(validConfig);
    mockMutate.mockResolvedValueOnce({});

    await run("archive", "--json", "t1");

    const output = JSON.parse(allOutput());
    expect(output.success).toBe(true);
    expect(output.id).toBe("t1");
  });
});

describe("threads get (human-readable)", () => {
  it("displays thread info and messages with body", async () => {
    mockLoadConfig.mockReturnValue(validConfig);
    mockQuery
      .mockResolvedValueOnce({
        id: "t1",
        generated_title: "Bug Report",
        created_at: "2024-01-15",
        resolved: false,
        channel: "support",
      })
      .mockResolvedValueOnce({
        list: [
          {
            messages: [
              { id: "m1", body: "Hello there", author_role: "user", created_at: "2024-01-15" },
              { id: "m2", body: "I can help", author_role: "bot", created_at: "2024-01-15" },
            ],
          },
        ],
      });

    await run("get", "t1");

    const output = allOutput();
    expect(output).toContain("Bug Report");
    expect(output).toContain("Messages");
    expect(output).toContain("Hello there");
    expect(output).toContain("I can help");
  });

  it("handles messages without body", async () => {
    mockLoadConfig.mockReturnValue(validConfig);
    mockQuery
      .mockResolvedValueOnce({ id: "t1", generated_title: "Empty Thread" })
      .mockResolvedValueOnce({
        list: [{ messages: [{ id: "m1", author_role: "user", created_at: "2024-01-15" }] }],
      });

    await run("get", "t1");

    const output = allOutput();
    expect(output).toContain("Empty Thread");
  });

  it("shows '(untitled thread)' when title is missing", async () => {
    mockLoadConfig.mockReturnValue(validConfig);
    mockQuery
      .mockResolvedValueOnce({ id: "t1", resolved: true })
      .mockResolvedValueOnce({ list: [] });

    await run("get", "t1");

    const output = allOutput();
    expect(output).toContain("(untitled thread)");
    expect(output).toContain("resolved");
  });

  it("shows 'unknown' role when author_role is missing", async () => {
    mockLoadConfig.mockReturnValue(validConfig);
    mockQuery.mockResolvedValueOnce({ id: "t1", generated_title: "Thread" }).mockResolvedValueOnce({
      list: [{ messages: [{ id: "m1", body: "test message" }] }],
    });

    await run("get", "t1");

    const output = allOutput();
    expect(output).toContain("unknown");
    expect(output).toContain("test message");
  });

  it("handles empty messages array", async () => {
    mockLoadConfig.mockReturnValue(validConfig);
    mockQuery
      .mockResolvedValueOnce({ id: "t1", generated_title: "Empty Thread" })
      .mockResolvedValueOnce({ list: [] });

    await run("get", "t1");

    const output = allOutput();
    expect(output).toContain("Empty Thread");
    // The "Messages (N)" header should not appear for empty messages
    expect(output).not.toMatch(/Messages \(\d+\)/);
  });
});

describe("requireConfig", () => {
  it("exits when space_id is missing", async () => {
    mockLoadConfig.mockReturnValue({ ...validConfig, space_id: undefined });
    await expect(run("list")).rejects.toThrow("exit");
    expect(exitSpy).toHaveBeenCalledWith(1);
  });

  it("exits when access_token is missing", async () => {
    mockLoadConfig.mockReturnValue({ ...validConfig, access_token: "" });
    await expect(run("list")).rejects.toThrow("exit");
  });
});
