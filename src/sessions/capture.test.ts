import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  captureCursorStop,
  captureHookSession,
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
    await expect(captureHookSession(broken)).resolves.toBeUndefined();
  });

  it("reads and ignores a non-Cursor payload", async () => {
    const stream = new PassThrough();
    const done = captureHookSession(stream);
    stream.end('{"session_id":"claude"}');
    await expect(done).resolves.toBeUndefined();
  });
});
