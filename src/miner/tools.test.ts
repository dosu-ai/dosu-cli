import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { AgentSession } from "../sessions/scan";
import {
  createSessionToolsServer,
  formatSessionList,
  MAX_READ_CHARS,
  readSessionPage,
} from "./tools";

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "dosu-miner-tools-test-"));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
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
});
