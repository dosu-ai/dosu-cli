import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { stripVTControlCharacters } from "node:util";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CliUsageError } from "../cli/errors";
import { saveConfig } from "../config/config";
import { makeTestConfig } from "../config/config.test-utils";
import { fakeSessiondb } from "../shipper/fake-sessiondb.test-utils";
import { sessionsCommand } from "./sessions";

const SERVER_URL = "https://sessions.test";
const TOKEN = "sdb_0123456789abcdef";
/** A reply long enough to learn from: the server skips shorter sessions. */
const REPLY = `It expired. ${"Tokens are revoked after ninety days. ".repeat(60)}`;

let dir: string;
let repo: string;
let server: ReturnType<typeof fakeSessiondb>;
let logSpy: ReturnType<typeof vi.spyOn>;
let errorSpy: ReturnType<typeof vi.spyOn>;

function jsonl(name: string, rows: unknown[], folder = dir): string {
  const path = join(folder, name);
  writeFileSync(path, `${rows.map((row) => JSON.stringify(row)).join("\n")}\n`);
  return path;
}

/** A Claude Code session in the `widget` checkout: a prompt, and a reply. */
function claudeFile(name = "sess1.jsonl", rows = 2, folder = dir): string {
  const turns = [
    {
      type: "user",
      uuid: "u1",
      timestamp: "2026-11-04T00:00:00.000Z",
      cwd: repo,
      sessionId: "sess1",
      message: { role: "user", content: "Why does the token fail?" },
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

/** What the command printed, without the colors CI forces on. */
function printed(spy: ReturnType<typeof vi.spyOn>): string {
  return stripVTControlCharacters(
    spy.mock.calls.map((call: unknown[]) => String(call[0])).join("\n"),
  );
}

function serverError(status: number, code: string): Response {
  return new Response(JSON.stringify({ error: { code, message: code } }), { status });
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "dosu-sessions-push-"));
  repo = join(dir, "widget");
  mkdirSync(repo);
  execFileSync("git", ["-C", repo, "init", "-q"]);
  execFileSync("git", ["-C", repo, "remote", "add", "origin", "git@github.com:acme/widget.git"]);
  vi.stubEnv("HOME", dir);
  vi.stubEnv("XDG_CONFIG_HOME", join(dir, ".config"));
  vi.stubEnv("DOSU_SESSIONDB_URL", `${SERVER_URL}/`);
  vi.stubEnv("DOSU_SESSIONDB_TOKEN", TOKEN);
  vi.stubEnv("DOSU_PROJECT", "");
  server = fakeSessiondb();
  vi.stubGlobal("fetch", server.fetchImpl);
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
  it("sends a Claude Code session's raw transcript to DOSU_SESSIONDB_URL with its token", async () => {
    const file = claudeFile();

    await run("push", file);

    const [url, init] = server.fetchImpl.mock.calls[0] ?? [];
    expect(url).toBe(`${SERVER_URL}/v1/sessions`);
    expect(new Headers(init?.headers).get("authorization")).toBe(`Bearer ${TOKEN}`);
    expect(server.uploads).toHaveLength(1);
    expect(server.uploads[0]).toMatchObject({
      agent: "claude-code",
      session_id: "sess1",
      project: "github.com/acme/widget",
      format: "jsonl",
    });
    expect(server.uploads[0]?.transcript).toContain(REPLY);
    expect(printed(logSpy)).toContain(file);
    expect(process.exitCode).toBeUndefined();
  });

  it("tells Codex and Cursor sessions apart by their content", async () => {
    await run("push", codexFile(), cursorFile());

    expect(server.uploads[0]).toMatchObject({
      agent: "codex",
      session_id: "rollout-2026-11-04T00-00-00-01a0ff74",
      project: "github.com/acme/widget",
    });
    // No working directory: no project to name.
    expect(server.uploads[1]).toMatchObject({
      agent: "cursor",
      session_id: "cursor1",
      project: "unknown",
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
    server.fetchImpl
      .mockImplementationOnce(server.handle)
      .mockResolvedValueOnce(serverError(422, "invalid_transcript"))
      .mockResolvedValueOnce(serverError(401, "unauthorized"))
      .mockRejectedValueOnce(new TypeError("fetch failed: getaddrinfo ENOTFOUND"));

    await run("push", missing, notes, unanswered, refused, unauthorized, offline, pushed);

    const errors = printed(errorSpy);
    expect(errors).toContain(`${missing}: cannot read the file (ENOENT)`);
    expect(errors).toContain(`${notes}: not a Claude Code, Codex, or Cursor session file`);
    expect(errors).toContain(`${refused}: the server refused the session (HTTP 422)`);
    expect(errors).toMatch(new RegExp(`${unauthorized}: not sent: .*unauthorized`));
    expect(errors).toMatch(new RegExp(`${offline}: not sent: .*ENOTFOUND`));
    expect(server.fetchImpl).toHaveBeenCalledTimes(5);
    const lines = printed(logSpy);
    expect(lines).toContain(`${unanswered}: skipped: too short to learn from`);
    expect(lines).toContain(`✓ ${pushed}`);
    expect(process.exitCode).toBe(1);
  });

  it("pushes to the configured server when the environment names none", async () => {
    vi.stubEnv("DOSU_SESSIONDB_URL", undefined);
    vi.stubEnv("DOSU_SESSIONDB_TOKEN", undefined);
    saveConfig({
      ...makeTestConfig({ access_token: "t", refresh_token: "r", expires_at: 0 }),
      targets: [{ name: "team", url: "https://team.test", owner: "ci", token: "sdb_team" }],
    });

    await run("push", claudeFile());

    expect(server.fetchImpl.mock.calls[0]?.[0]).toBe("https://team.test/v1/sessions");
  });

  it("refuses to run with only one of DOSU_SESSIONDB_URL and DOSU_SESSIONDB_TOKEN", async () => {
    vi.stubEnv("DOSU_SESSIONDB_TOKEN", " ");

    const error = await run("push", claudeFile()).catch((err: unknown) => err);

    expect(error).toBeInstanceOf(CliUsageError);
    expect(server.fetchImpl).not.toHaveBeenCalled();
  });

  it("refuses a plain http:// server that is not this machine", async () => {
    vi.stubEnv("DOSU_SESSIONDB_URL", "http://sessions.example.com");

    const error = await run("push", claudeFile()).catch((err: unknown) => err);

    expect(error).toBeInstanceOf(CliUsageError);
    expect(String(error)).toContain("https://");
    expect(server.fetchImpl).not.toHaveBeenCalled();
  });

  it("refuses to run with no server to push to", async () => {
    vi.stubEnv("DOSU_SESSIONDB_URL", undefined);
    vi.stubEnv("DOSU_SESSIONDB_TOKEN", undefined);

    const error = await run("push", claudeFile()).catch((err: unknown) => err);

    expect(error).toBeInstanceOf(CliUsageError);
    expect(String(error)).toContain("no sessiondb server to push to");
    expect(server.fetchImpl).not.toHaveBeenCalled();
  });
});

describe("dosu sessions push from a runner's task", () => {
  it("pushes the files of the task's own agent directory, under DOSU_PROJECT", async () => {
    // A runner gives each task its own Claude Code directory and clones through its own gateway,
    // so the origin names no repository on GitHub.
    execFileSync("git", [
      "-C",
      repo,
      "remote",
      "set-url",
      "origin",
      "http://git.internal/acme/widget.git",
    ]);
    vi.stubEnv("DOSU_PROJECT", "github.com/acme/widget");
    const project = join(dir, "work", "attempt-1", "claude", "projects", "-widget");
    mkdirSync(join(project, "task", "subagents"), { recursive: true });
    const main = claudeFile("task.jsonl", 2, project);
    const subagent = claudeFile("agent-a1.jsonl", 2, join(project, "task", "subagents"));

    await run("push", main, subagent);

    expect(server.uploads).toHaveLength(2);
    expect(server.uploads[0]).toMatchObject({
      project: "github.com/acme/widget",
      agent: "claude-code",
      session_id: "task",
    });
    expect(server.uploads[1]).toMatchObject({
      project: "github.com/acme/widget",
      session_id: "agent-a1",
      parent_session_id: "task",
    });
    expect(process.exitCode).toBeUndefined();
  });
});
