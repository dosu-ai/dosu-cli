import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CommandError } from "../cli/command-error";
import { sessionsCommand } from "./sessions";

const BACKEND = "https://api.dosu.test";
const KEY = "dxi_live_0123456789abcdefghijklmnopqrstuv";
const GITHUB_TOKEN = "ghp_abcdefghijklmnopqrstuvwxyz012345";
/** A reply long enough to learn from: the shipper skips shorter sessions (shipper/worthiness.ts). */
const REPLY = `It expired. ${"Tokens are revoked after ninety days. ".repeat(60)}`;

let dir: string;
let repo: string;
let logSpy: ReturnType<typeof vi.spyOn>;
let errorSpy: ReturnType<typeof vi.spyOn>;
const fetchMock = vi.fn<(url: string, init: RequestInit) => Promise<Response>>();

function queued(): Response {
  return new Response(JSON.stringify({ status: "queued" }), { status: 202 });
}

function jsonl(name: string, rows: unknown[], folder = dir): string {
  const path = join(folder, name);
  writeFileSync(path, `${rows.map((row) => JSON.stringify(row)).join("\n")}\n`);
  return path;
}

/** A Claude Code session in the `widget` checkout: a token in the prompt, and a reply. */
function claudeFile(name = "sess1.jsonl", rows = 2, folder = dir): string {
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
      message: { role: "assistant", content: [{ type: "text", text: REPLY }] },
    },
  ];
  return jsonl(name, turns.slice(0, rows), folder);
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
    message("assistant", "output_text", REPLY),
  ]);
}

/** A Cursor transcript, which records no working directory. */
function cursorFile(): string {
  return jsonl("cursor1.jsonl", [
    { role: "user", message: { content: [{ type: "text", text: "<user_query>hi</user_query>" }] } },
    { role: "assistant", message: { content: [{ type: "text", text: REPLY }] } },
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
  // The agents' stores and the CLI's own files, all in the test's directory.
  vi.stubEnv("HOME", join(dir, "home"));
  vi.stubEnv("XDG_CONFIG_HOME", join(dir, "config"));
  for (const name of ["CLAUDE_CONFIG_DIR", "CODEX_HOME", "XDG_DATA_HOME", "PI_CODING_AGENT_DIR"]) {
    vi.stubEnv(name, undefined);
  }
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
    const unauthorized = claudeFile("unauthorized.jsonl");
    const offline = claudeFile("offline.jsonl");
    const pushed = claudeFile("pushed.jsonl");
    fetchMock
      .mockResolvedValueOnce(new Response("{}", { status: 422 }))
      .mockResolvedValueOnce(new Response("{}", { status: 401 }))
      .mockRejectedValueOnce(new Error("getaddrinfo ENOTFOUND"));

    await run("push", missing, notes, unanswered, refused, unauthorized, offline, pushed);

    const errors = printed(errorSpy);
    expect(errors).toContain(`${missing}: cannot read the file (ENOENT)`);
    expect(errors).toContain(`${notes}: not a Claude Code, Codex, or Cursor session file`);
    expect(errors).toContain(`${refused}: Dosu refused the session (HTTP 422)`);
    expect(errors).toContain(`${unauthorized}: not sent: ingest failed: HTTP 401`);
    expect(errors).toContain(`${offline}: not sent: getaddrinfo ENOTFOUND`);
    expect(fetchMock).toHaveBeenCalledTimes(4);
    const lines = printed(logSpy);
    expect(lines).toContain(`${unanswered}: skipped: too short to learn from`);
    expect(lines).toContain(`✓ ${pushed}`);
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

  it("asks for files or --since, not both or neither", async () => {
    const neither = await run("push").catch((err: unknown) => err);
    const both = await run("push", claudeFile(), "--since", "2026-11-04T00:00:00Z").catch(
      (err: unknown) => err,
    );
    const notATime = await run("push", "--since", "yesterday-ish").catch((err: unknown) => err);

    expect(neither).toMatchObject({ code: "INVALID_ARGUMENT", message: "Nothing to push" });
    expect(both).toMatchObject({
      code: "INVALID_ARGUMENT",
      message: "Name session files or --since, not both",
    });
    expect(notATime).toMatchObject({
      code: "INVALID_ARGUMENT",
      message: "--since yesterday-ish is not a time",
    });
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe("dosu sessions push --since", () => {
  /** A Claude Code session in the agent's own store, last active at `at`. */
  function stored(id: string, at: Date, configDir = join(dir, "home", ".claude")): string {
    const project = join(configDir, "projects", "-widget");
    mkdirSync(project, { recursive: true });
    const path = claudeFile(`${id}.jsonl`, 2, project);
    utimesSync(path, at, at);
    return path;
  }

  const since = new Date("2026-11-05T22:00:00Z");
  const before = new Date("2026-11-05T21:00:00Z");
  const after = new Date("2026-11-05T22:05:00Z");

  it("pushes every session the machine's agents kept since the time, oldest first", async () => {
    stored("old", before);
    const first = stored("first", after);
    const relocated = join(dir, "work", "claude");
    vi.stubEnv("CLAUDE_CONFIG_DIR", relocated);
    const second = stored("second", new Date("2026-11-05T22:10:00Z"), relocated);

    await run("push", "--since", since.toISOString());

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(sent(0).body.metadata).toMatchObject({ agent: "claude-code", session_id: "first" });
    expect(sent(1).body.metadata).toMatchObject({ session_id: "second" });
    expect(sent(1).url).toBe(`${BACKEND}/v1/memory/ingest`);
    expect(printed(logSpy)).toContain(`✓ ${first}`);
    expect(printed(logSpy)).toContain(`✓ ${second}`);
    expect(process.exitCode).toBeUndefined();
  });

  it("files the sessions under DOSU_PROJECT when their checkout's origin doesn't name it", async () => {
    // A runner clones through its own gateway: the origin names no repository on GitHub.
    execFileSync("git", [
      "-C",
      repo,
      "remote",
      "set-url",
      "origin",
      "http://git.internal/acme/widget.git",
    ]);
    vi.stubEnv("DOSU_PROJECT", "github.com/acme/widget");
    stored("task", after);

    await run("push", "--since", since.toISOString());

    expect(sent().body.metadata).toMatchObject({ project: "github.com/acme/widget" });
    expect(sent().body.metadata.repo).toBeUndefined();
  });

  it("says so when there is nothing since the time", async () => {
    stored("old", before);

    await run("push", "--since", since.toISOString());

    expect(fetchMock).not.toHaveBeenCalled();
    expect(printed(logSpy)).toContain(`No agent sessions since ${since.toISOString()}.`);
    expect(process.exitCode).toBeUndefined();
  });
});
