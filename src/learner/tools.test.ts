import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AgentSession } from "../sessions/scan";
import {
  createSessionToolsServer,
  formatSessionList,
  MAX_READ_CHARS,
  readSessionPage,
} from "./tools";

type ToolResult = { content: { type: string; text: string }[]; isError?: boolean };
type ToolHandler = (args: Record<string, unknown>, extra: unknown) => Promise<ToolResult>;

// Capture the handlers passed to `tool()` while still building the real SDK
// server, so the in-process tool bodies can be exercised directly.
const capturedTools = vi.hoisted(() => new Map<string, ToolHandler>());
vi.mock("@anthropic-ai/claude-agent-sdk", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@anthropic-ai/claude-agent-sdk")>();
  return {
    ...actual,
    tool: (name: string, description: string, schema: never, handler: ToolHandler) => {
      capturedTools.set(name, handler);
      return actual.tool(name, description, schema, handler as never);
    },
  };
});

// Passthrough reader with an optional per-test override for the failure path.
const readOverride = vi.hoisted(() => ({ fn: undefined as (() => never) | undefined }));
vi.mock("../sessions/read", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../sessions/read")>();
  return {
    ...actual,
    readSessionTurns: (s: AgentSession) =>
      readOverride.fn ? readOverride.fn() : actual.readSessionTurns(s),
  };
});

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "dosu-learner-tools-test-"));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
  readOverride.fn = undefined;
});

function writeClaudeLog(
  name: string,
  turns: { role: "user" | "assistant"; text: string }[],
): string {
  const path = join(dir, name);
  const lines = turns.map((t) =>
    JSON.stringify({
      type: t.role,
      message: {
        role: t.role,
        content: t.role === "user" ? t.text : [{ type: "text", text: t.text }],
      },
    }),
  );
  writeFileSync(path, lines.join("\n"));
  return path;
}

function session(path: string, id = "s1", project?: string): AgentSession {
  return { id, harness: "claude", path, updated: "2026-08-27T00:00:00.000Z", project };
}

describe("formatSessionList", () => {
  it("lists id, agent, updated, and project when present", () => {
    const list = formatSessionList([
      session("/tmp/a.jsonl", "abc", "my-repo"),
      session("/tmp/b.jsonl", "def"),
    ]);

    expect(list).toContain("id=abc agent=claude updated=2026-08-27T00:00:00.000Z project=my-repo");
    expect(list).toContain("id=def agent=claude");
  });

  it("handles an empty scope", () => {
    expect(formatSessionList([])).toBe("No sessions in scope for this run.");
  });
});

describe("readSessionPage", () => {
  it("renders numbered turns with roles", () => {
    const path = writeClaudeLog("a.jsonl", [
      { role: "user", text: "why is the build red" },
      { role: "assistant", text: "missing env var" },
    ]);

    const page = readSessionPage(session(path));

    expect(page.text).toContain("turns 0–1 of 2");
    expect(page.text).toContain("[0] USER:\nwhy is the build red");
    expect(page.text).toContain("[1] ASSISTANT:\nmissing env var");
    expect(page.nextOffset).toBeUndefined();
  });

  it("redacts secrets in turn content (second belt)", () => {
    const path = writeClaudeLog("b.jsonl", [
      {
        role: "user",
        text: "use OPENAI_API_KEY=sk-proj-abcdefghijklmnopqrstuvwx1234567890ABCDEFGH",
      },
    ]);

    const page = readSessionPage(session(path));

    expect(page.text).not.toContain("sk-proj-abcdefghijklmnopqrst");
    expect(page.text).toContain("[redacted:");
  });

  it("paginates when turns exceed the response budget and resumes from offset", () => {
    const big = "x".repeat(MAX_READ_CHARS - 5);
    const path = writeClaudeLog("c.jsonl", [
      { role: "user", text: big },
      { role: "assistant", text: "short reply" },
    ]);

    const first = readSessionPage(session(path));
    expect(first.nextOffset).toBe(1);
    expect(first.text).toContain("call read_session again with offset=1");

    const second = readSessionPage(session(path), 1);
    expect(second.text).toContain("[1] ASSISTANT:\nshort reply");
    expect(second.nextOffset).toBeUndefined();
  });

  it("stops before a turn that would overflow the budget once something is rendered", () => {
    // Two mid-sized turns: the first fits with room to spare, the second would
    // push the page past the budget, so the page ends after the first turn
    // instead of truncating the second.
    const half = "z".repeat(Math.floor(MAX_READ_CHARS * 0.6));
    const path = writeClaudeLog("f.jsonl", [
      { role: "user", text: half },
      { role: "assistant", text: half },
      { role: "user", text: "tail" },
    ]);

    const page = readSessionPage(session(path));

    expect(page.text).toContain("turns 0–0 of 3");
    expect(page.text).not.toContain("[1] ASSISTANT");
    expect(page.nextOffset).toBe(1);
    expect(page.text).toContain("call read_session again with offset=1");
  });

  it("truncates a single turn larger than the budget but still progresses", () => {
    const huge = "y".repeat(MAX_READ_CHARS * 2);
    const path = writeClaudeLog("d.jsonl", [
      { role: "user", text: huge },
      { role: "user", text: "after" },
    ]);

    const page = readSessionPage(session(path));

    expect(page.text.length).toBeLessThan(MAX_READ_CHARS + 500);
    expect(page.nextOffset).toBe(1);
  });

  it("reports empty and out-of-range reads gracefully", () => {
    const path = writeClaudeLog("e.jsonl", [{ role: "user", text: "only one" }]);

    expect(readSessionPage(session(join(dir, "missing.jsonl"))).text).toContain(
      "no readable conversation turns",
    );
    expect(readSessionPage(session(path), 5).text).toContain("past the end");
  });
});

describe("createSessionToolsServer", () => {
  it("builds an in-process SDK MCP server", () => {
    const server = createSessionToolsServer([session("/tmp/a.jsonl")]);

    expect(server.type).toBe("sdk");
    expect(server.name).toBe("sessions");
    expect(server.instance).toBeDefined();
  });

  describe("tool handlers", () => {
    function handlers(sessions: AgentSession[]) {
      capturedTools.clear();
      createSessionToolsServer(sessions);
      const list = capturedTools.get("list_sessions");
      const read = capturedTools.get("read_session");
      if (!list || !read) throw new Error("expected both tools to be registered");
      return { list, read };
    }

    it("list_sessions returns the formatted in-scope list", async () => {
      const { list } = handlers([session("/tmp/a.jsonl", "abc", "my-repo")]);

      const result = await list({}, {});

      expect(result.isError).toBeUndefined();
      expect(result.content).toEqual([
        { type: "text", text: expect.stringContaining("id=abc agent=claude") },
      ]);
      expect(result.content[0].text).toContain("project=my-repo");
    });

    it("read_session returns an error result for an id outside the run's scope", async () => {
      const { read } = handlers([session("/tmp/a.jsonl", "abc")]);

      const result = await read({ id: "nope" }, {});

      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain("Unknown session id nope");
    });

    it("read_session renders the page from the start when offset is omitted", async () => {
      const path = writeClaudeLog("h1.jsonl", [
        { role: "user", text: "first" },
        { role: "assistant", text: "second" },
      ]);
      const { read } = handlers([session(path, "abc")]);

      const result = await read({ id: "abc" }, {});

      expect(result.isError).toBeUndefined();
      expect(result.content[0].text).toContain("turns 0–1 of 2");
      expect(result.content[0].text).toContain("[0] USER:\nfirst");
    });

    it("read_session honors an explicit offset", async () => {
      const path = writeClaudeLog("h2.jsonl", [
        { role: "user", text: "first" },
        { role: "assistant", text: "second" },
      ]);
      const { read } = handlers([session(path, "abc")]);

      const result = await read({ id: "abc", offset: 1 }, {});

      expect(result.content[0].text).toContain("turns 1–1 of 2");
      expect(result.content[0].text).not.toContain("[0] USER");
      expect(result.content[0].text).toContain("[1] ASSISTANT:\nsecond");
    });

    it("read_session reports a reader Error as a tool error", async () => {
      readOverride.fn = () => {
        throw new Error("disk exploded");
      };
      const { read } = handlers([session("/tmp/a.jsonl", "abc")]);

      const result = await read({ id: "abc" }, {});

      expect(result.isError).toBe(true);
      expect(result.content[0].text).toBe("Failed to read session abc: disk exploded");
    });

    it("read_session stringifies a non-Error reader failure", async () => {
      readOverride.fn = () => {
        throw "plain string failure";
      };
      const { read } = handlers([session("/tmp/a.jsonl", "abc")]);

      const result = await read({ id: "abc" }, {});

      expect(result.isError).toBe(true);
      expect(result.content[0].text).toBe("Failed to read session abc: plain string failure");
    });
  });
});
