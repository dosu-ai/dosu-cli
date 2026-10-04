import { appendFileSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ChunkRequest, MemoryApi } from "./api";
import {
  memoryDir,
  newSessionState,
  readSessionState,
  type SessionState,
  sessionLockPath,
  writeSessionState,
} from "./state";
import { type SyncDeps, syncSession } from "./sync";

vi.mock("../debug/logger", () => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

const SESSION = "5f0c2a1e-7b3d-4c8e-9a61-2d4f8b0e1c37";
const API: MemoryApi = { backendURL: "http://memory.test", apiKey: "test-key" };
const TS = "2026-10-01T10:00:00.000Z";

let dir: string;
let transcript: string;
let requests: Array<{ url: string; body: unknown }>;
let statuses: number[];

const prompt = (text: string) =>
  `${JSON.stringify({ type: "user", timestamp: TS, origin: { kind: "human" }, message: { content: text } })}\n`;
const reply = (text: string) =>
  `${JSON.stringify({ type: "assistant", timestamp: TS, message: { content: [{ type: "text", text }] } })}\n`;
const noise = `${JSON.stringify({ type: "attachment", timestamp: TS, attachment: { type: "date" } })}\n`;

const fetchImpl = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
  requests.push({ url: String(url), body: JSON.parse(String(init?.body)) });
  const status = statuses.shift() ?? 200;
  return new Response(status === 200 ? "{}" : "nope", { status });
}) as unknown as typeof fetch;

function deps(extra: Partial<SyncDeps> = {}): SyncDeps {
  return {
    api: API,
    fetchImpl,
    configDir: dir,
    snapshot: () => "diff --git a/x b/x",
    retryDelaysMs: [],
    lockWaitMs: 0,
    ...extra,
  };
}

const chunks = () =>
  requests.filter((r) => r.url.endsWith("/events")).map((r) => r.body as ChunkRequest);

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "dosu-memory-sync-"));
  transcript = join(dir, "session.jsonl");
  writeFileSync(transcript, "");
  requests = [];
  statuses = [];
  writeSessionState(
    newSessionState({
      session_id: SESSION,
      agent: "claude-code",
      transcript_path: transcript,
      cwd: "/w",
      repo: "acme/widgets",
      start_head: "abc123",
      recall_mode: "two_stage",
    }),
    dir,
  );
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe("syncSession", () => {
  it("uploads new lines and resumes from the saved offset, leaving a partial line for later", async () => {
    appendFileSync(transcript, prompt("Add a widget") + noise + reply("Done."));
    expect(await syncSession(SESSION, {}, deps())).toEqual({
      status: "uploaded",
      chunks: 1,
      flushed: false,
    });

    const partial = reply("Second turn");
    appendFileSync(transcript, noise + prompt("Now test it") + partial.slice(0, 20));
    await syncSession(SESSION, {}, deps());
    appendFileSync(transcript, partial.slice(20));
    await syncSession(SESSION, {}, deps());
    expect(await syncSession(SESSION, {}, deps())).toMatchObject({ status: "nothing-new" });

    expect(
      chunks().map(({ seq, first_line, last_line, events }) => [
        seq,
        first_line,
        last_line,
        events.length,
      ]),
    ).toEqual([
      [0, 1, 3, 2],
      [1, 4, 5, 1],
      [2, 6, 6, 1],
    ]);
    expect(requests[0].url).toBe(`http://memory.test/v1/agent-memory/sessions/${SESSION}/events`);
    expect(chunks()[0]).toMatchObject({
      repo: "acme/widgets",
      source: "claude_code",
      diff: "diff --git a/x b/x",
      events: [
        { type: "user_prompt", ts: TS, text: "Add a widget" },
        { type: "assistant_text", ts: TS, text: "Done." },
      ],
    });
    expect(readSessionState(SESSION, dir)).toMatchObject({
      line_offset: 6,
      next_seq: 3,
      outbox: null,
    });
  });

  it("moves the cursor without a request when the new lines hold no events", async () => {
    appendFileSync(transcript, noise + noise);
    expect(await syncSession(SESSION, {}, deps())).toMatchObject({ status: "nothing-new" });
    expect(requests).toEqual([]);
    expect(readSessionState(SESSION, dir)).toMatchObject({ line_offset: 2, next_seq: 0 });
  });

  it("keeps the cursor after a failed upload and resends the identical chunk first", async () => {
    appendFileSync(transcript, prompt("First"));
    statuses = [503];
    expect(await syncSession(SESSION, {}, deps())).toMatchObject({ status: "failed", chunks: 0 });
    expect(readSessionState(SESSION, dir)).toMatchObject({ line_offset: 0, next_seq: 0 });

    appendFileSync(transcript, prompt("Second"));
    expect(await syncSession(SESSION, {}, deps({ snapshot: () => "changed" }))).toMatchObject({
      status: "uploaded",
      chunks: 2,
    });

    const [failed, resent, next] = chunks();
    expect(resent).toEqual(failed);
    expect(next).toMatchObject({ seq: 1, first_line: 2, last_line: 2, diff: "changed" });
  });

  it("drops a chunk the backend rejects as invalid instead of retrying it forever", async () => {
    appendFileSync(transcript, prompt("First"));
    statuses = [422];
    expect(await syncSession(SESSION, {}, deps({ retryDelaysMs: [1, 1] }))).toMatchObject({
      status: "nothing-new",
      chunks: 0,
    });
    expect(requests).toHaveLength(1);
    expect(readSessionState(SESSION, dir)).toMatchObject({
      line_offset: 1,
      next_seq: 1,
      outbox: null,
    });
  });

  it("redacts secrets in events and the diff before they leave the machine", async () => {
    const token = `ghp_${"A1b2C3d4".repeat(5)}`;
    appendFileSync(
      transcript,
      prompt(`Use ${token} to clone`) +
        JSON.stringify({
          type: "assistant",
          timestamp: TS,
          message: {
            content: [
              {
                type: "tool_use",
                id: "t1",
                name: "Bash",
                input: { command: `GH_TOKEN=${token} gh repo list` },
              },
            ],
          },
        }) +
        "\n" +
        JSON.stringify({
          type: "user",
          timestamp: TS,
          message: { content: [{ type: "tool_result", tool_use_id: "t1", content: "ok" }] },
        }) +
        "\n",
    );
    await syncSession(
      SESSION,
      {},
      deps({ snapshot: () => '+DB_PASSWORD = "correct-horse-battery-staple"' }),
    );

    const body = JSON.stringify(chunks()[0]);
    expect(body).not.toContain(token);
    expect(body).not.toContain("correct-horse-battery-staple");
    expect(
      chunks()[0].events.map((e) => ("text" in e ? e.text : "command" in e ? e.command : "")),
    ).toEqual([
      "Use [redacted:github-token] to clone",
      "GH_TOKEN=[redacted:credential] gh repo list",
    ]);
    expect(chunks()[0].diff).toBe('+DB_PASSWORD = "[redacted:credential]"');
  });

  it("flushes after the last chunk lands, not while one is pending or before any landed", async () => {
    expect(await syncSession(SESSION, { flush: true }, deps())).toMatchObject({ flushed: false });
    expect(requests).toEqual([]);

    appendFileSync(transcript, prompt("First"));
    statuses = [500];
    expect(await syncSession(SESSION, { flush: true }, deps())).toMatchObject({ flushed: false });
    expect(requests.map((r) => r.url)).toEqual([
      `http://memory.test/v1/agent-memory/sessions/${SESSION}/events`,
    ]);

    expect(await syncSession(SESSION, { flush: true }, deps())).toEqual({
      status: "uploaded",
      chunks: 1,
      flushed: true,
    });
    expect(requests.at(-1)?.url).toBe(
      `http://memory.test/v1/agent-memory/sessions/${SESSION}/flush`,
    );
  });

  it("waits for a concurrent sync of the same session, then gives up", async () => {
    writeFileSync(sessionLockPath(SESSION, dir), String(process.pid));
    appendFileSync(transcript, prompt("First"));
    expect(await syncSession(SESSION, {}, deps())).toMatchObject({ status: "busy" });
    expect(requests).toEqual([]);
  });

  it("does nothing without state, a repository, or credentials", async () => {
    expect(await syncSession("unknown", {}, deps())).toMatchObject({ status: "no-state" });
    expect(await syncSession(SESSION, {}, deps({ api: null }))).toMatchObject({
      status: "not-configured",
    });
    const state = readSessionState(SESSION, dir);
    writeSessionState({ ...(state as NonNullable<typeof state>), repo: null }, dir);
    expect(await syncSession(SESSION, {}, deps())).toMatchObject({ status: "no-repo" });
    expect(memoryDir(dir)).toBe(join(dir, "agent-memory"));
  });
});

describe("syncSession for Codex", () => {
  it("uploads what the rollout's completed items say, and nothing without a rollout", async () => {
    const rollout = join(dir, "rollout.jsonl");
    writeFileSync(rollout, readFileSync(join(__dirname, "testdata", "codex-0.153-session.jsonl")));
    const state = readSessionState(SESSION, dir) as SessionState;
    writeSessionState({ ...state, agent: "codex", transcript_path: rollout }, dir);

    expect(await syncSession(SESSION, { flush: true }, deps())).toEqual({
      status: "uploaded",
      chunks: 1,
      flushed: true,
    });
    expect(chunks()[0]).toMatchObject({
      source: "codex",
      seq: 0,
      first_line: 1,
      last_line: 35,
    });
    expect(chunks()[0].events.filter((event) => event.type === "command")).toHaveLength(6);

    writeSessionState(
      { ...(readSessionState(SESSION, dir) as SessionState), transcript_path: null },
      dir,
    );
    expect((await syncSession(SESSION, {}, deps())).status).toBe("nothing-new");
  });
});

describe("syncSession for Cursor", () => {
  it("uploads the event log its hooks wrote, as source cursor, skipping a torn line", async () => {
    const log = join(dir, "events.jsonl");
    const command = { type: "command", ts: TS, command: "make test", rc: 2, error_line: "E x" };
    writeFileSync(
      log,
      `${JSON.stringify({ type: "user_prompt", ts: TS, text: "Fix it" })}\n{"type":"comm\n${JSON.stringify(command)}\n`,
    );
    const state = readSessionState(SESSION, dir) as SessionState;
    writeSessionState({ ...state, agent: "cursor", transcript_path: log }, dir);

    expect((await syncSession(SESSION, {}, deps())).status).toBe("uploaded");
    expect(chunks()[0]).toMatchObject({
      source: "cursor",
      first_line: 1,
      last_line: 3,
      events: [{ type: "user_prompt", ts: TS, text: "Fix it" }, command],
    });
  });
});
