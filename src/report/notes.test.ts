import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { AgentSession } from "../sessions/scan";
import {
  attributeRediscovery,
  cycleMatchScore,
  noteWords,
  sessionCycles,
  sessionIdFromReadInput,
  sessionsToInventory,
} from "./notes";
import { extractUserQueries, sessionTitleFromUserText } from "./queries";

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "dosu-report-notes-"));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

function jsonlSession(
  id: string,
  harness: AgentSession["harness"],
  lines: unknown[],
): AgentSession {
  const path = join(dir, `${id}.jsonl`);
  writeFileSync(path, lines.map((l) => JSON.stringify(l)).join("\n"));
  return { id, harness, path, updated: "2026-09-09T00:00:00.000Z" };
}

function claudeSession(id: string, lines: unknown[]): AgentSession {
  return jsonlSession(id, "claude", lines);
}

describe("sessionIdFromReadInput", () => {
  it("reads the session id from read_session input", () => {
    expect(sessionIdFromReadInput({ id: "abc", offset: 2 })).toBe("abc");
    expect(sessionIdFromReadInput({ offset: 0 })).toBeUndefined();
    expect(sessionIdFromReadInput(["id"])).toBeUndefined();
    expect(sessionIdFromReadInput({ id: "  " })).toBeUndefined();
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

  it("ignores notes whose transcript id matches no scanned session", () => {
    const session = claudeSession("s1", [
      { type: "user", message: { content: "why does oauth retry?" } },
    ]);
    const [unknown, bare] = attributeRediscovery(
      [
        { title: "OAuth retry", content: "Retry.", transcript_id: "not-scanned" },
        { title: "No transcript", content: "Bare." },
      ],
      [session],
    );
    expect(unknown.approx_rediscovery_tokens).toBeUndefined();
    expect(bare.approx_rediscovery_tokens).toBeUndefined();
  });

  it("keeps the session title but assigns no cycle when only scaffolding matches", () => {
    const session = claudeSession("s1", [
      { type: "user", message: { content: "# AGENTS.md\nrules" } },
      { type: "user", message: { content: "find the oauth retry in tokens.py" } },
      { type: "assistant", message: { content: [{ type: "text", text: "retry after 401" }] } },
    ]);
    const [note] = attributeRediscovery(
      [{ title: "OAuth retry tokens.py", content: "Retry after 401.", transcript_id: "s1" }],
      [session],
    );
    expect(note.session_title).toBe("find the oauth retry in tokens.py");
    expect(note.approx_rediscovery_tokens).toBeGreaterThan(0);
  });

  it("counts a zero-token user turn as zero, not as a missing cycle", () => {
    // A one-character Codex prompt estimates to 0 tokens; the cycle total must
    // still be the assistant's cost, not NaN and not undefined.
    const answer = "retry after 401 lives in tokens.py";
    const session = jsonlSession("cx", "codex", [
      { type: "event_msg", payload: { type: "user_message", message: "a" } },
      { type: "event_msg", payload: { type: "agent_message", message: answer } },
    ]);
    const [note] = attributeRediscovery(
      [{ title: "OAuth retry tokens.py", content: "Retry after 401.", transcript_id: "cx" }],
      [session],
    );
    expect(note.approx_rediscovery_tokens).toBe(Math.round(answer.length / 4));
    expect(note.investigation_lines).toBe("1-2");
    expect(note.user_query).toBe("a");
    expect(note.session_title).toBe("a");
  });
});

describe("sessionCycles and noteWords", () => {
  it("flattens tool previews into cycle text and tolerates turns without tools", () => {
    const cycles = sessionCycles([
      { role: "user", text: ["where is retry"] },
      { role: "assistant", text: [], tools: [{ name: "Search", query: "retry" }] },
      {
        role: "assistant",
        text: ["in tokens.py"],
        tools: [
          { name: "Grep", pattern: "refresh_grant" },
          { name: "Shell", command_preview: "rg refresh_grant" },
          { name: "Read", path: "src/auth/tokens.py" },
        ],
      },
      { role: "user", text: "   " },
    ]);
    expect(cycles).toHaveLength(1);
    expect(cycles[0]).toMatchObject({ start: 0, end: 4 });
    expect(cycles[0].text).toContain("refresh_grant rg refresh_grant src/auth/tokens.py");
    expect(cycles[0].text).not.toContain("Search");
  });

  it("returns empty vocabularies for titles and bodies with no words", () => {
    const words = noteWords({ title: "", content: "!!! 42" });
    expect(words.title.size).toBe(0);
    expect(words.content.size).toBe(0);
    expect(cycleMatchScore(words, "anything at all")).toBe(0);
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

  it("omits the title key entirely when a session has no user query", () => {
    const session = claudeSession("s3", [
      { type: "assistant", message: { content: [{ type: "text", text: "unprompted note" }] } },
    ]);
    const row = sessionsToInventory([session]).transcripts[0];
    expect("title" in row).toBe(false);
    expect(row.user_queries).toEqual([]);
    expect(row.learning_tokens).toBe(Math.round("unprompted note".length / 4));
  });
});
