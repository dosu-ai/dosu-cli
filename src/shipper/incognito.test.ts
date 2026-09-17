import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AgentSession } from "../sessions/scan";
import { INCOGNITO_MARKER, isIncognitoSession, textHasIncognitoMarker } from "./incognito";

const mockReadSessionTurns = vi.hoisted(() => vi.fn());
vi.mock("../sessions/read", () => ({
  readSessionTurns: (...args: unknown[]) => mockReadSessionTurns(...args),
}));

let dir: string;

beforeEach(() => {
  mockReadSessionTurns.mockReset();
  dir = mkdtempSync(join(tmpdir(), "dosu-ship-incognito-"));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

function session(path: string, harness: AgentSession["harness"] = "claude"): AgentSession {
  return { id: "s1", harness, path, updated: "2026-09-01T00:00:00.000Z" };
}

describe("textHasIncognitoMarker", () => {
  it("detects the versioned marker token", () => {
    expect(textHasIncognitoMarker(`please note ${INCOGNITO_MARKER} in this session`)).toBe(true);
  });

  it("detects Claude Code's command-name record", () => {
    expect(textHasIncognitoMarker("<command-name>/dosu-incognito</command-name>")).toBe(true);
  });

  it("stays negative on ordinary text", () => {
    expect(textHasIncognitoMarker("just a normal transcript line")).toBe(false);
  });
});

describe("isIncognitoSession", () => {
  it("scans the raw transcript of file-backed harnesses", () => {
    const path = join(dir, "s1.jsonl");
    writeFileSync(path, `{"type":"user","message":{"content":"${INCOGNITO_MARKER}"}}\n`);
    expect(isIncognitoSession(session(path))).toBe(true);
  });

  it("reads a marker-free transcript as not incognito", () => {
    const path = join(dir, "s1.jsonl");
    writeFileSync(path, '{"type":"user","message":{"content":"hello"}}\n');
    expect(isIncognitoSession(session(path))).toBe(false);
  });

  it("treats an unreadable transcript as not incognito", () => {
    expect(isIncognitoSession(session(join(dir, "missing.jsonl")))).toBe(false);
  });

  it("falls back to parsed turns for opencode (sqlite) sessions", () => {
    mockReadSessionTurns.mockReturnValue([
      { role: "user", text: "hello" },
      { role: "user", text: `going dark: ${INCOGNITO_MARKER}` },
    ]);
    expect(isIncognitoSession(session(join(dir, "opencode.db"), "opencode"))).toBe(true);
    expect(mockReadSessionTurns).toHaveBeenCalled();
  });
});
