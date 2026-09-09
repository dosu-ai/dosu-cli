import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { AgentSession } from "../sessions/scan";
import {
  appendWrittenNotes,
  attributeRediscovery,
  parseWriteKnowledgeInput,
  sessionIdFromReadInput,
  sessionsToInventory,
  WRITTEN_NOTES_LIMIT,
} from "./notes";
import { extractUserQueries, sessionTitleFromUserText } from "./queries";

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "dosu-report-notes-"));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

function claudeSession(id: string, lines: unknown[]): AgentSession {
  const path = join(dir, `${id}.jsonl`);
  writeFileSync(path, lines.map((l) => JSON.stringify(l)).join("\n"));
  return { id, harness: "claude", path, updated: "2026-09-09T00:00:00.000Z" };
}

describe("parseWriteKnowledgeInput", () => {
  it("captures title, content, and the last-read session id", () => {
    expect(
      parseWriteKnowledgeInput(
        { title: "OAuth refresh", content: "Retry after 401.", repo: "git@x/y" },
        "sess-1",
      ),
    ).toEqual({
      title: "OAuth refresh",
      content: "Retry after 401.",
      transcript_id: "sess-1",
      repo: "git@x/y",
    });
  });

  it("rejects empty payloads", () => {
    expect(parseWriteKnowledgeInput({})).toBeNull();
    expect(parseWriteKnowledgeInput({ title: "  ", content: "" })).toBeNull();
    expect(parseWriteKnowledgeInput(null)).toBeNull();
  });

  it("prefers an explicit transcript_id on the payload", () => {
    expect(
      parseWriteKnowledgeInput({ title: "A", content: "B", transcript_id: "explicit" }, "last"),
    ).toMatchObject({ transcript_id: "explicit" });
  });

  it("falls back to session_id when transcript_id is absent", () => {
    expect(
      parseWriteKnowledgeInput({ title: "A", content: "B", session_id: "from-miner" }, "last"),
    ).toMatchObject({ transcript_id: "from-miner" });
  });

  it("omits transcript_id when the payload and last-read id are empty", () => {
    expect(
      parseWriteKnowledgeInput({ title: "A", content: "B", transcript_id: "  ", session_id: "  " }),
    ).toEqual({ title: "A", content: "B" });
  });
});

describe("sessionIdFromReadInput", () => {
  it("reads the session id from read_session input", () => {
    expect(sessionIdFromReadInput({ id: "abc", offset: 2 })).toBe("abc");
    expect(sessionIdFromReadInput({ offset: 0 })).toBeUndefined();
  });
});

describe("appendWrittenNotes", () => {
  it("caps at WRITTEN_NOTES_LIMIT keeping the newest", () => {
    const existing = Array.from({ length: WRITTEN_NOTES_LIMIT }, (_, i) => ({
      title: `old-${i}`,
      content: "x",
    }));
    const next = appendWrittenNotes(existing, [{ title: "new", content: "y" }]);
    expect(next).toHaveLength(WRITTEN_NOTES_LIMIT);
    expect(next[0].title).toBe("old-1");
    expect(next.at(-1)?.title).toBe("new");
  });
});

describe("attributeRediscovery", () => {
  it("gives each note its matching user-query cycle, not the whole session", () => {
    const session = claudeSession("s1", [
      { type: "user", message: { content: "why does auth retry?" } },
      { type: "assistant", message: { content: [{ type: "text", text: "because 401" }] } },
      { type: "user", message: { content: "and the refresh path?" } },
      { type: "assistant", message: { content: [{ type: "text", text: "see tokens.py" }] } },
    ]);
    const notes = [
      { title: "OAuth retry", content: "Retry after 401.", transcript_id: "s1" },
      { title: "Refresh path", content: "tokens.py owns it.", transcript_id: "s1" },
    ];
    const [first, second] = attributeRediscovery(notes, [session]);
    expect(first.approx_rediscovery_tokens).toBeGreaterThan(0);
    expect(second.approx_rediscovery_tokens).toBeGreaterThan(0);
    expect(first.approx_rediscovery_tokens).toBeLessThan(
      (first.approx_rediscovery_tokens ?? 0) + (second.approx_rediscovery_tokens ?? 0),
    );
    expect(
      (first.approx_rediscovery_tokens ?? 0) + (second.approx_rediscovery_tokens ?? 0),
    ).toBeLessThanOrEqual(
      "why does auth retry?".length / 4 +
        "because 401".length / 4 +
        "and the refresh path?".length / 4 +
        "see tokens.py".length / 4 +
        2,
    );
    expect(first.user_query).toContain("why does auth retry?");
    expect(second.user_query).toContain("refresh path");
    expect(first.investigation_lines).toBe("1-2");
    expect(second.investigation_lines).toBe("3-4");
    expect(first.status).toBe("written");
  });

  it("does not invent a session-sized number for a later note", () => {
    const long = "x".repeat(4000);
    const session = claudeSession("s1", [
      { type: "user", message: { content: "unrelated scaffolding question" } },
      { type: "assistant", message: { content: [{ type: "text", text: long }] } },
      { type: "user", message: { content: "why does oauth retry after 401" } },
      { type: "assistant", message: { content: [{ type: "text", text: "retry after 401" }] } },
    ]);
    const [note] = attributeRediscovery(
      [{ title: "OAuth retry after 401", content: "Retry after 401.", transcript_id: "s1" }],
      [session],
    );
    expect(note.approx_rediscovery_tokens).toBeGreaterThan(0);
    expect(note.approx_rediscovery_tokens).toBeLessThan(long.length / 4);
    expect(note.investigation_lines).toBe("3-4");
  });

  it("never assigns the same cycle twice; the loser and no-overlap notes get no tokens", () => {
    const session = claudeSession("s1", [
      { type: "user", message: { content: "why does oauth retry after 401" } },
      { type: "assistant", message: { content: [{ type: "text", text: "retry after 401" }] } },
    ]);
    const notes = [
      { title: "OAuth retry after 401", content: "Retry after 401.", transcript_id: "s1" },
      { title: "OAuth retry", content: "Also about the 401 retry.", transcript_id: "s1" },
      { title: "Unrelated zebra fact", content: "Zebras have stripes.", transcript_id: "s1" },
    ];
    const results = attributeRediscovery(notes, [session]);
    const withTokens = results.filter((r) => (r.approx_rediscovery_tokens ?? 0) > 0);
    expect(withTokens).toHaveLength(1);
    expect(withTokens[0].title).toBe("OAuth retry after 401");
    expect(results[2].approx_rediscovery_tokens).toBeUndefined();
  });

  it("matches a cycle through tool paths and patterns when the text never names the file", () => {
    const session = claudeSession("s1", [
      { type: "user", message: { content: "where is the refresh handled?" } },
      {
        type: "assistant",
        message: {
          content: [
            { type: "tool_use", name: "Read", input: { path: "src/auth/tokens.py" } },
            { type: "tool_use", name: "Grep", input: { pattern: "refresh_grant" } },
            { type: "tool_use", name: "Shell", input: { command: "rg refresh_grant" } },
          ],
        },
      },
    ]);
    const [note] = attributeRediscovery(
      [{ title: "tokens.py refresh_grant", content: "tokens.py owns it.", transcript_id: "s1" }],
      [session],
    );
    expect(note.approx_rediscovery_tokens).toBeGreaterThan(0);
    expect(note.investigation_lines).toBe("1-2");
  });

  it("skips rediscovery tokens when the session has no turns", () => {
    const session = claudeSession("empty", []);
    const [note] = attributeRediscovery(
      [{ title: "A", content: "B", transcript_id: "empty" }],
      [session],
    );
    expect(note.user_query).toBeUndefined();
    expect(note.investigation_lines).toBeUndefined();
    expect(note.approx_rediscovery_tokens).toBeUndefined();
  });
});

describe("extractUserQueries", () => {
  it("pulls the inner user_query and drops timestamp wrappers", () => {
    expect(
      extractUserQueries(
        "<user_query>\ncheck slack\n</user_query>\n<timestamp>2026-09-09</timestamp>",
      ),
    ).toEqual(["check slack"]);
    expect(sessionTitleFromUserText("<user_query>fix oauth retry after 401</user_query>")).toBe(
      "fix oauth retry after 401",
    );
  });
});

describe("sessionsToInventory", () => {
  it("uses learning_tokens not tool-call counts", () => {
    const session = claudeSession("s1", [
      { type: "user", message: { content: "hello there friend" } },
      { type: "assistant", message: { content: [{ type: "text", text: "working on it now" }] } },
    ]);
    const inventory = sessionsToInventory([session]);
    expect(inventory.transcripts[0]).toMatchObject({
      source: "claude",
      transcript_id: "s1",
      title: "hello there friend",
      rediscovery_tool_calls: 0,
    });
    expect(inventory.totals?.learning_tokens).toBe(inventory.transcripts[0].learning_tokens);
    expect(inventory.totals?.learning_tokens).toBeGreaterThan(0);
  });

  it("counts rediscovery tools and strips Cursor wrappers from the title", () => {
    const session = claudeSession("s2", [
      {
        type: "user",
        message: { content: "<user_query>check out how slack is implemented</user_query>" },
      },
      {
        type: "assistant",
        message: {
          content: [
            { type: "text", text: "looking" },
            { type: "tool_use", name: "Read", input: {} },
            { type: "tool_use", name: "Grep", input: {} },
          ],
        },
      },
    ]);
    const row = sessionsToInventory([session]).transcripts[0];
    expect(row.title).toBe("check out how slack is implemented");
    expect(row.user_queries).toEqual(["check out how slack is implemented"]);
    expect(row.rediscovery_tool_calls).toBe(2);
  });
});
