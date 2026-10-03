import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  captureCursorStop,
  captureHookSession,
  endedSessionOf,
  readCapturedSession,
  readHookStdin,
  recordCapturedSession,
} from "./capture";

vi.mock("../debug/logger", () => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

let configDir: string;

beforeEach(() => {
  configDir = mkdtempSync(join(tmpdir(), "dosu-capture-test-"));
});

afterEach(() => {
  rmSync(configDir, { recursive: true, force: true });
});

const NOW = new Date("2026-09-29T12:00:00.000Z");

describe("recordCapturedSession", () => {
  it("persists per session and keeps an earlier branch through a detached turn", () => {
    expect(readCapturedSession("cursor/abc", configDir)).toBeNull();
    expect(
      recordCapturedSession("cursor/abc", { dir: "/w", branch: "feat/x" }, configDir, NOW),
    ).toBe(true);
    recordCapturedSession("cursor/abc", { dir: "/w", branch: null }, configDir, NOW);
    expect(readCapturedSession("cursor/abc", configDir)).toEqual({
      dir: "/w",
      branch: "feat/x",
      at: NOW.toISOString(),
    });

    recordCapturedSession("cursor/abc", { branch: "main" }, configDir, NOW);
    expect(readCapturedSession("cursor/abc", configDir)?.branch).toBe("main");
    expect(readCapturedSession("cursor/other", configDir)).toBeNull();
  });

  it("records a detached first turn with its directory only", () => {
    recordCapturedSession("cursor/d", { dir: "/w", branch: null }, configDir, NOW);
    expect(readCapturedSession("cursor/d", configDir)).toEqual({
      dir: "/w",
      at: NOW.toISOString(),
    });
  });

  it("rejects keys that could escape the capture directory", () => {
    for (const key of ["cursor/../x", "cursor", "cursor/a/b", "../x/y", "cursor/a.b"]) {
      expect(recordCapturedSession(key, { branch: "main" }, configDir, NOW)).toBe(false);
      expect(readCapturedSession(key, configDir)).toBeNull();
    }
  });

  it("drops fields of the wrong type and fails soft on an unwritable config dir", () => {
    recordCapturedSession("cursor/t", { dir: "/w" }, configDir, NOW);
    writeFileSync(
      join(configDir, "session-captures", "cursor", "t.json"),
      JSON.stringify({ dir: 1, branch: ["x"] }),
    );
    expect(readCapturedSession("cursor/t", configDir)).toEqual({ at: "" });

    const occupied = join(configDir, "file");
    writeFileSync(occupied, "x");
    expect(recordCapturedSession("cursor/t", { branch: "main" }, occupied, NOW)).toBe(false);
  });
});

describe("captureCursorStop", () => {
  const payload = {
    cursor_version: "2.0.0",
    conversation_id: "conv-1",
    transcript_path: "/home/u/.cursor/projects/p/agent-transcripts/uuid-1/uuid-1.jsonl",
    workspace_roots: ["/work/app"],
  };

  it("records the workspace root's branch under the transcript stem", () => {
    const currentBranch = vi.fn(() => "feat/cursor");
    expect(captureCursorStop(payload, { currentBranch, configDir, now: NOW })).toBe(true);
    expect(currentBranch).toHaveBeenCalledWith("/work/app");
    expect(readCapturedSession("cursor/uuid-1", configDir)).toEqual({
      dir: "/work/app",
      branch: "feat/cursor",
      at: NOW.toISOString(),
    });
  });

  it("falls back to the conversation id without a transcript path", () => {
    const deps = { currentBranch: () => "main", configDir, now: NOW };
    expect(captureCursorStop({ ...payload, transcript_path: null }, deps)).toBe(true);
    expect(readCapturedSession("cursor/conv-1", configDir)?.branch).toBe("main");
  });

  it("ignores other agents' payloads and payloads missing an id or a workspace", () => {
    const deps = { currentBranch: () => "main", configDir, now: NOW };
    expect(captureCursorStop(null, deps)).toBe(false);
    expect(captureCursorStop({ session_id: "claude", cwd: "/w" }, deps)).toBe(false);
    expect(
      captureCursorStop({ ...payload, transcript_path: undefined, conversation_id: 7 }, deps),
    ).toBe(false);
    expect(captureCursorStop({ ...payload, workspace_roots: [] }, deps)).toBe(false);
    expect(captureCursorStop({ ...payload, workspace_roots: ["relative"] }, deps)).toBe(false);
  });

  it("asks real git by default and records only the directory outside a repo", () => {
    const outsideRepo = mkdtempSync(join(tmpdir(), "dosu-capture-norepo-"));
    try {
      const stop = { ...payload, workspace_roots: [outsideRepo] };
      expect(captureCursorStop(stop, { configDir, now: NOW })).toBe(true);
      expect(readCapturedSession("cursor/uuid-1", configDir)).toEqual({
        dir: outsideRepo,
        at: NOW.toISOString(),
      });
    } finally {
      rmSync(outsideRepo, { recursive: true, force: true });
    }
  });
});

describe("readHookStdin", () => {
  it("parses a JSON payload once stdin closes", async () => {
    const stream = new PassThrough();
    const read = readHookStdin(stream, 1_000);
    stream.write('{"cursor_version":');
    stream.end('"1"}');
    await expect(read).resolves.toEqual({ cursor_version: "1" });
  });

  it("is null on a TTY, bad JSON, an oversized payload, an error, or a stdin left open", async () => {
    await expect(readHookStdin(Object.assign(new PassThrough(), { isTTY: true }))).resolves.toBe(
      null,
    );

    const bad = new PassThrough();
    const badRead = readHookStdin(bad, 1_000);
    bad.end("not json");
    await expect(badRead).resolves.toBeNull();

    const big = new PassThrough();
    const bigRead = readHookStdin(big, 1_000, 4);
    big.write("12345");
    await expect(bigRead).resolves.toBeNull();

    const failing = new PassThrough();
    const failRead = readHookStdin(failing, 1_000);
    failing.emit("error", new Error("boom"));
    await expect(failRead).resolves.toBeNull();

    await expect(readHookStdin(new PassThrough(), 10)).resolves.toBeNull();
  });

  it("keeps the first result when the stream errors after ending", async () => {
    const stream = new PassThrough();
    const read = readHookStdin(stream, 1_000);
    stream.emit("data", Buffer.from("[1]"));
    stream.emit("end");
    stream.emit("error", new Error("late"));
    await expect(read).resolves.toEqual([1]);
  });

  it("accepts string chunks", async () => {
    const stream = new PassThrough({ encoding: "utf-8" });
    const read = readHookStdin(stream, 1_000);
    stream.end("[1]");
    await expect(read).resolves.toEqual([1]);
  });
});

describe("captureHookSession", () => {
  it("never throws, even when the stream itself does", async () => {
    const broken = {
      on: () => {
        throw new Error("boom");
      },
    } as unknown as NodeJS.ReadableStream;
    await expect(captureHookSession(broken)).resolves.toBeNull();
    const throwsString = {
      on: () => {
        throw "boom";
      },
    } as unknown as NodeJS.ReadableStream;
    await expect(captureHookSession(throwsString)).resolves.toBeNull();
  });

  it("ignores an unreadable payload", async () => {
    const stream = new PassThrough();
    const done = captureHookSession(stream);
    stream.end("not json");
    await expect(done).resolves.toBeNull();
  });

  it("reads and ignores a payload that is not an end event", async () => {
    const stream = new PassThrough();
    const done = captureHookSession(stream);
    stream.end('{"session_id":"claude"}');
    await expect(done).resolves.toBeNull();
  });

  it("names the session a Claude Code SessionEnd hook reports", async () => {
    const stream = new PassThrough();
    const done = captureHookSession(stream);
    stream.end(
      JSON.stringify({
        session_id: "0a1b2c3d-4e5f-6789-abcd-ef0123456789",
        transcript_path:
          "/home/u/.claude/projects/-work-app/0a1b2c3d-4e5f-6789-abcd-ef0123456789.jsonl",
        cwd: "/work/app",
        hook_event_name: "SessionEnd",
        reason: "exit",
      }),
    );
    await expect(done).resolves.toEqual({
      harness: "claude",
      id: "0a1b2c3d-4e5f-6789-abcd-ef0123456789",
      path: "/home/u/.claude/projects/-work-app/0a1b2c3d-4e5f-6789-abcd-ef0123456789.jsonl",
    });
  });
});

describe("endedSessionOf", () => {
  const claudeEnd = {
    session_id: "abc-123",
    transcript_path: "/home/u/.claude/projects/-work-app/abc-123.jsonl",
    hook_event_name: "SessionEnd",
  };

  it("reads a Claude Code SessionEnd", () => {
    expect(endedSessionOf(claudeEnd)).toEqual({
      harness: "claude",
      id: "abc-123",
      path: claudeEnd.transcript_path,
    });
  });

  // Codex 0.160+: the payload names the session by uuid, the transcript is a rollout file.
  const rollout = "rollout-2026-10-02T17-28-17-01a0ff29-62b1-7310-94a2-45a5c2140458";
  const codexEnd = {
    session_id: "01a0ff29-62b1-7310-94a2-45a5c2140458",
    transcript_path: `/home/u/.codex/sessions/2026/10/02/${rollout}.jsonl`,
    cwd: "/work/app",
    hook_event_name: "SessionEnd",
    reason: "other",
  };

  it("reads a Codex SessionEnd, naming the session by its rollout as the scanner does", () => {
    expect(endedSessionOf(codexEnd)).toEqual({
      harness: "codex",
      id: rollout,
      path: codexEnd.transcript_path,
    });
  });

  it.each([
    ["a per-turn Stop event", { ...claudeEnd, hook_event_name: "Stop" }],
    ["Codex's per-turn Stop", { ...codexEnd, hook_event_name: "Stop", turn_id: "t1" }],
    [
      "a Codex SessionEnd whose rollout belongs to another session",
      { ...codexEnd, session_id: "01a0ff29-0000-7000-8000-000000000000" },
    ],
    ["a Codex SessionEnd with no transcript", { ...codexEnd, transcript_path: null }],
    [
      "Cursor's per-turn stop",
      { conversation_id: "c1", cursor_version: "1.2", status: "completed" },
    ],
    // Codex's own end event names a rollout file, not the session id: its reader is separate.
    [
      "a SessionEnd whose transcript is not named for the session",
      { ...claudeEnd, transcript_path: "/home/u/.codex/sessions/2026/10/02/rollout-x.jsonl" },
    ],
    [
      "an unsafe session id",
      { ...claudeEnd, session_id: "../../etc", transcript_path: "/x/../../etc.jsonl" },
    ],
    ["no transcript path", { ...claudeEnd, transcript_path: undefined }],
    [
      "OpenCode's per-turn idle",
      { agent: "opencode", hook_event_name: "opencode.session.idle", session_id: "ses_a" },
    ],
    [
      "an OpenCode end with an unsafe session id",
      { agent: "opencode", hook_event_name: "opencode.session.end", session_id: "ses_a'; --" },
    ],
    [
      "an OpenCode end event from another agent",
      { agent: "pi", hook_event_name: "opencode.session.end", session_id: "ses_a" },
    ],
    ["not an object", "SessionEnd"],
    ["null", null],
  ])("ignores %s", (_label, payload) => {
    expect(endedSessionOf(payload)).toBeNull();
  });
});
