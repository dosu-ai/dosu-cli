import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AgentSession } from "../sessions/scan";

const mockReadTurns = vi.hoisted(() => vi.fn());
vi.mock("../sessions/read", () => ({
  readSessionTurns: (...args: unknown[]) => mockReadTurns(...args),
}));

import {
  INCOGNITO_COMMAND_NAME,
  INCOGNITO_MARKER,
  isIncognitoSession,
  partitionIncognitoSessions,
  textHasIncognitoMarker,
  transcriptHasIncognitoMarker,
} from "./incognito";

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "dosu-incognito-"));
  mockReadTurns.mockReset();
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

function write(name: string, lines: unknown[]): string {
  const path = join(dir, name);
  writeFileSync(path, `${lines.map((l) => JSON.stringify(l)).join("\n")}\n`);
  return path;
}

function session(overrides: Partial<AgentSession>): AgentSession {
  return {
    id: "s1",
    harness: "claude",
    path: join(dir, "missing.jsonl"),
    updated: "2026-08-25T12:00:00Z",
    ...overrides,
  };
}

/** Claude Code's slash-command record: the command name wrapper, as recorded in real logs. */
const CLAUDE_COMMAND_TURN = {
  type: "user",
  message: {
    role: "user",
    content: `<command-name>/${INCOGNITO_COMMAND_NAME}</command-name>\n<command-message>${INCOGNITO_COMMAND_NAME}</command-message>\n<command-args></command-args>`,
  },
};

const CURSOR_EXPANDED_TURN = {
  role: "user",
  message: {
    content: [
      {
        type: "text",
        text: `Dosu incognito marker: ${INCOGNITO_MARKER}\nDosu is off for this session.`,
      },
    ],
  },
};

const CODEX_EXPANDED_TURN = {
  type: "response_item",
  payload: {
    type: "message",
    role: "user",
    content: [{ type: "input_text", text: `Dosu incognito marker: ${INCOGNITO_MARKER}` }],
  },
};

describe("textHasIncognitoMarker", () => {
  it("matches the body token and the Claude command-name wrapper", () => {
    expect(textHasIncognitoMarker(`hello ${INCOGNITO_MARKER} world`)).toBe(true);
    expect(textHasIncognitoMarker(`<command-name>/${INCOGNITO_COMMAND_NAME}</command-name>`)).toBe(
      true,
    );
  });

  it("ignores unrelated text and other commands", () => {
    expect(textHasIncognitoMarker("<command-name>/model</command-name>")).toBe(false);
    expect(textHasIncognitoMarker("dosu:incognito")).toBe(false);
    expect(textHasIncognitoMarker("")).toBe(false);
  });
});

describe("transcriptHasIncognitoMarker", () => {
  it("detects the Claude command-name record", () => {
    const path = write("claude.jsonl", [
      { type: "user", message: { role: "user", content: "fix the tests" } },
      CLAUDE_COMMAND_TURN,
      {
        type: "assistant",
        message: { role: "assistant", content: [{ type: "text", text: "ok" }] },
      },
    ]);
    expect(transcriptHasIncognitoMarker(path)).toBe(true);
  });

  it("detects the expanded body in Cursor and Codex shapes", () => {
    expect(transcriptHasIncognitoMarker(write("cursor.jsonl", [CURSOR_EXPANDED_TURN]))).toBe(true);
    expect(transcriptHasIncognitoMarker(write("codex.jsonl", [CODEX_EXPANDED_TURN]))).toBe(true);
  });

  it("is false for ordinary transcripts, empty files, and missing files", () => {
    const plain = write("plain.jsonl", [
      { type: "user", message: { role: "user", content: "what does this function do" } },
    ]);
    expect(transcriptHasIncognitoMarker(plain)).toBe(false);
    const empty = join(dir, "empty.jsonl");
    writeFileSync(empty, "");
    expect(transcriptHasIncognitoMarker(empty)).toBe(false);
    expect(transcriptHasIncognitoMarker(join(dir, "nope.jsonl"))).toBe(false);
  });

  it("only scans up to the byte cap", () => {
    const path = write("late.jsonl", [
      { type: "user", message: { role: "user", content: "x".repeat(500) } },
      CLAUDE_COMMAND_TURN,
    ]);
    expect(transcriptHasIncognitoMarker(path, 100)).toBe(false);
    expect(transcriptHasIncognitoMarker(path)).toBe(true);
  });
});

describe("isIncognitoSession", () => {
  it("reads the transcript for file-backed harnesses", () => {
    const marked = write("marked.jsonl", [CURSOR_EXPANDED_TURN]);
    expect(isIncognitoSession(session({ harness: "cursor", path: marked }))).toBe(true);
    expect(isIncognitoSession(session({ harness: "codex" }))).toBe(false);
    expect(mockReadTurns).not.toHaveBeenCalled();
  });

  it("falls back to parsed turns for opencode", () => {
    mockReadTurns.mockReturnValue([
      { role: "user", text: "hi" },
      { role: "user", text: `please go ${INCOGNITO_MARKER}` },
    ]);
    expect(isIncognitoSession(session({ harness: "opencode", path: "/db.sqlite" }))).toBe(true);
    mockReadTurns.mockReturnValue([{ role: "user", text: "hi" }]);
    expect(isIncognitoSession(session({ harness: "opencode", path: "/db.sqlite" }))).toBe(false);
  });
});

describe("partitionIncognitoSessions", () => {
  it("splits by the predicate, preserving order", () => {
    const a = session({ id: "a" });
    const b = session({ id: "b" });
    const c = session({ id: "c" });
    const { kept, skipped } = partitionIncognitoSessions([a, b, c], (s) => s.id === "b");
    expect(kept.map((s) => s.id)).toEqual(["a", "c"]);
    expect(skipped.map((s) => s.id)).toEqual(["b"]);
  });

  it("defaults to transcript detection", () => {
    const marked = write("m.jsonl", [CLAUDE_COMMAND_TURN]);
    const { kept, skipped } = partitionIncognitoSessions([
      session({ id: "plain" }),
      session({ id: "marked", path: marked }),
    ]);
    expect(kept.map((s) => s.id)).toEqual(["plain"]);
    expect(skipped.map((s) => s.id)).toEqual(["marked"]);
  });
});
