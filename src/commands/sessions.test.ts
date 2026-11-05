import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CommandError } from "../cli/command-error";
import { sessionsCommand } from "./sessions";

const BACKEND = "https://api.dosu.test";
const KEY = "dxi_live_0123456789abcdefghijklmnopqrstuv";
const GITHUB_TOKEN = "ghp_abcdefghijklmnopqrstuvwxyz012345";

let dir: string;
let repo: string;
let logSpy: ReturnType<typeof vi.spyOn>;
let errorSpy: ReturnType<typeof vi.spyOn>;
const fetchMock = vi.fn<(url: string, init: RequestInit) => Promise<Response>>();

function queued(): Response {
  return new Response(JSON.stringify({ status: "queued" }), { status: 202 });
}

function jsonl(name: string, rows: unknown[]): string {
  const path = join(dir, name);
  writeFileSync(path, `${rows.map((row) => JSON.stringify(row)).join("\n")}\n`);
  return path;
}

/** A Claude Code session in the `widget` checkout: a token in the prompt, and a reply. */
function claudeFile(name = "sess1.jsonl", rows = 2): string {
  const turns = [
    {
      type: "user",
      uuid: "u1",
      timestamp: "2026-11-04T00:00:00.000Z",
      cwd: repo,
      sessionId: "sess1",
      message: { role: "user", content: `Why does ${GITHUB_TOKEN} fail?` },
    },
    {
      type: "assistant",
      uuid: "a1",
      timestamp: "2026-11-04T00:00:05.000Z",
      sessionId: "sess1",
      message: { role: "assistant", content: [{ type: "text", text: "It expired." }] },
    },
  ];
  return jsonl(name, turns.slice(0, rows));
}

function codexFile(): string {
  const at = "2026-11-04T00:00:00.000Z";
  const message = (role: string, type: string, text: string) => ({
    timestamp: at,
    type: "response_item",
    payload: { type: "message", role, content: [{ type, text }] },
  });
  return jsonl("rollout-2026-11-04T00-00-00-01a0ff74.jsonl", [
    { timestamp: at, type: "session_meta", payload: { id: "01a0ff74", timestamp: at, cwd: repo } },
    message("user", "input_text", "Run the tests"),
    message("assistant", "output_text", "They pass."),
  ]);
}

/** A Cursor transcript, which records no working directory. */
function cursorFile(): string {
  return jsonl("cursor1.jsonl", [
    { role: "user", message: { content: [{ type: "text", text: "<user_query>hi</user_query>" }] } },
    { role: "assistant", message: { content: [{ type: "text", text: "hello" }] } },
  ]);
}

async function run(...args: string[]): Promise<void> {
  await sessionsCommand().parseAsync(["node", "sessions", ...args]);
}

function printed(spy: ReturnType<typeof vi.spyOn>): string {
  return spy.mock.calls.map((call: unknown[]) => String(call[0])).join("\n");
}

interface Sent {
  url: string;
  headers: Record<string, string>;
  body: { records: { role: string }[]; metadata: Record<string, unknown> };
  raw: string;
}

function sent(call = 0): Sent {
  const [url, init] = fetchMock.mock.calls[call];
  const raw = String(init.body);
  return { url, headers: init.headers as Record<string, string>, body: JSON.parse(raw), raw };
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "dosu-sessions-push-"));
  repo = join(dir, "widget");
  mkdirSync(repo);
  execFileSync("git", ["-C", repo, "init", "-q"]);
  execFileSync("git", ["-C", repo, "remote", "add", "origin", "git@github.com:acme/widget.git"]);
  vi.stubEnv("DOSU_BACKEND_URL_OVERRIDE", `${BACKEND}/`);
  vi.stubEnv("DOSU_INGEST_KEY", KEY);
  vi.stubEnv("DOSU_PROJECT", "");
  fetchMock.mockReset();
  fetchMock.mockImplementation(async () => queued());
  vi.stubGlobal("fetch", fetchMock);
  logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
  errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
  process.exitCode = undefined;
});

afterEach(() => {
  logSpy.mockRestore();
  errorSpy.mockRestore();
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  process.exitCode = undefined;
  rmSync(dir, { recursive: true, force: true });
});

describe("dosu sessions push", () => {
  it("sends a Claude Code session, redacted, with its repository, to the ingest API", async () => {
    const file = claudeFile();

    await run("push", file);

    const { url, headers, body, raw } = sent();
    expect(url).toBe(`${BACKEND}/v1/memory/ingest`);
    expect(headers).toMatchObject({ Authorization: `Bearer ${KEY}` });
    expect(body.metadata).toEqual({
      project: "github.com/acme/widget",
      repo: "acme/widget",
      agent: "claude-code",
      session_id: "sess1",
    });
    expect(body.records.map((r) => r.role)).toEqual(["meta", "user", "assistant"]);
    expect(raw).not.toContain(GITHUB_TOKEN);
    expect(printed(logSpy)).toContain(file);
    expect(process.exitCode).toBeUndefined();
  });

  it("tells Codex and Cursor sessions apart by their content", async () => {
    await run("push", codexFile(), cursorFile());

    expect(sent(0).body.metadata).toMatchObject({
      agent: "codex",
      session_id: "rollout-2026-11-04T00-00-00-01a0ff74",
      repo: "acme/widget",
    });
    // No working directory: no project to name.
    expect(sent(1).body.metadata).toEqual({
      project: "unknown",
      agent: "cursor",
      session_id: "cursor1",
    });
  });

  it("reports each file it could not push and still pushes the rest", async () => {
    const missing = join(dir, "missing.jsonl");
    const notes = jsonl("notes.jsonl", [{ note: "not a session" }]);
    const unanswered = claudeFile("unanswered.jsonl", 1);
    const refused = claudeFile("refused.jsonl");
    const offline = claudeFile("offline.jsonl");
    const pushed = claudeFile("pushed.jsonl");
    fetchMock
      .mockResolvedValueOnce(new Response("{}", { status: 401 }))
      .mockRejectedValueOnce(new Error("getaddrinfo ENOTFOUND"));

    await run("push", missing, notes, unanswered, refused, offline, pushed);

    const errors = printed(errorSpy);
    expect(errors).toContain(`${missing}: cannot read the file (ENOENT)`);
    expect(errors).toContain(`${notes}: not a Claude Code, Codex, or Cursor session file`);
    expect(errors).toContain(`${unanswered}: no conversation Dosu can read in it`);
    expect(errors).toContain(`${refused}: Dosu refused the session (HTTP 401)`);
    expect(errors).toContain(`${offline}: could not reach Dosu: getaddrinfo ENOTFOUND`);
    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect(printed(logSpy)).toContain(pushed);
    expect(process.exitCode).toBe(1);
  });

  it("refuses to run without DOSU_INGEST_KEY", async () => {
    vi.stubEnv("DOSU_INGEST_KEY", " ");

    const error = await run("push", claudeFile()).catch((err: unknown) => err);

    expect(error).toBeInstanceOf(CommandError);
    expect(error).toMatchObject({
      code: "INVALID_ARGUMENT",
      message: "DOSU_INGEST_KEY is not set",
    });
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
