/** `dosu knowledge sync` over pi sessions, as setup's backfill and the Dosu pi extension run it: a
 * temporary home with real pi transcripts, git checkouts, config and ledger, and only the ingest
 * API and the detached re-spawn faked. */

import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { saveConfig } from "../config/config";
import { makeTestConfig } from "../config/config.test-utils";
import { loadSyncState } from "../sync/state";
import { knowledgeCommand } from "./knowledge";

/** The detached re-spawn is a process boundary: record its argv instead of starting a process. */
const mockSpawn = vi.hoisted(() => vi.fn(() => ({ unref: () => {} })));
vi.mock("node:child_process", async (importOriginal) => ({
  ...(await importOriginal<typeof import("node:child_process")>()),
  spawn: mockSpawn,
}));

let home: string;
type Fetch = (input: string, init?: RequestInit) => Promise<Response>;
let fetchImpl: ReturnType<typeof vi.fn<Fetch>>;

beforeEach(() => {
  home = realpathSync(mkdtempSync(join(tmpdir(), "dosu-knowledge-sync-pi-")));
  vi.stubEnv("HOME", home);
  vi.stubEnv("XDG_CONFIG_HOME", join(home, ".config"));
  vi.stubEnv("XDG_DATA_HOME", join(home, ".local", "share"));
  vi.stubEnv("CODEX_HOME", join(home, ".codex"));
  vi.stubEnv("CLAUDE_CONFIG_DIR", undefined);
  vi.stubEnv("PI_CODING_AGENT_DIR", undefined);
  vi.stubEnv("PI_CODING_AGENT_SESSION_DIR", undefined);
  vi.stubEnv("DOSU_DEV", undefined);
  vi.stubEnv("DOSU_PROJECT", undefined);
  vi.stubEnv("DOSU_BACKEND_URL_OVERRIDE", "https://api.dosu.test");
  saveConfig(
    makeTestConfig({
      access_token: "t",
      refresh_token: "r",
      expires_at: 0,
      api_key: "sk_test",
      deployment_id: "dep1",
    }),
  );
  fetchImpl = vi.fn<Fetch>(
    async () => new Response(JSON.stringify({ task_id: "task" }), { status: 202 }),
  );
  vi.stubGlobal("fetch", fetchImpl);
});

afterEach(() => {
  vi.restoreAllMocks();
  mockSpawn.mockClear();
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  rmSync(home, { recursive: true, force: true });
});

async function dosu(...args: string[]): Promise<void> {
  const cmd = knowledgeCommand();
  cmd.exitOverride();
  await cmd.parseAsync(["node", "dosu", ...args]);
}

interface Posted {
  records: { role: string; content?: unknown }[];
  metadata: Record<string, unknown>;
}

function posted(): Posted[] {
  return fetchImpl.mock.calls.map(([, init]) => JSON.parse(init?.body as string));
}

/** A git checkout under the temporary home with one commit, and an origin when given one. */
function gitRepo(name: string, origin?: string): string {
  const dir = join(home, "work", name);
  mkdirSync(dir, { recursive: true });
  const git = (...args: string[]) =>
    execFileSync("git", ["-C", dir, "-c", "user.name=t", "-c", "user.email=t@t", ...args], {
      encoding: "utf-8",
      stdio: ["ignore", "pipe", "ignore"],
    });
  git("init", "-q");
  if (origin) git("remote", "add", "origin", origin);
  git("commit", "-q", "--allow-empty", "-m", "init");
  return dir;
}

function rootCommit(dir: string): string {
  return execFileSync("git", ["-C", dir, "rev-list", "--max-parents=0", "HEAD"], {
    encoding: "utf-8",
  }).trim();
}

/** One pi exchange: the user asks, the model reads a file and answers at length. */
function exchange(n: number, ask = `question ${n}`): unknown[] {
  return [
    {
      type: "message",
      id: `u${n}`,
      message: { role: "user", content: [{ type: "text", text: ask }] },
    },
    {
      type: "message",
      id: `a${n}`,
      message: {
        role: "assistant",
        model: "claude-haiku-4-5",
        content: [
          { type: "text", text: `Reading calc.py for ${n}.` },
          { type: "toolCall", id: `c${n}`, name: "read", arguments: { path: "calc.py" } },
        ],
      },
    },
    {
      type: "message",
      id: `r${n}`,
      message: {
        role: "toolResult",
        toolCallId: `c${n}`,
        toolName: "read",
        content: [{ type: "text", text: "def add(a, b):\n    return a + b\n" }],
      },
    },
    {
      type: "message",
      id: `f${n}`,
      message: {
        role: "assistant",
        model: "claude-haiku-4-5",
        content: [{ type: "text", text: `answer ${n}: ${"detail ".repeat(400)}` }],
      },
    },
  ];
}

/** A pi transcript where pi keeps one for `cwd`, last written `minutesAgo` minutes ago. */
function piSession(
  id: string,
  cwd: string,
  entries: unknown[],
  options: { minutesAgo?: number; parentSession?: string; agentDir?: string } = {},
): string {
  const agentDir = options.agentDir ?? join(home, ".pi", "agent");
  const dir = join(agentDir, "sessions", `--${cwd.slice(1).replaceAll("/", "-")}--`);
  mkdirSync(dir, { recursive: true });
  const path = join(dir, `2026-10-02T17-59-42-611Z_${id}.jsonl`);
  const header = {
    type: "session",
    version: 3,
    id,
    timestamp: "2026-10-02T17:59:42.611Z",
    cwd,
    ...(options.parentSession ? { parentSession: options.parentSession } : {}),
  };
  const system = { type: "message", id: "s0", message: { role: "system", content: "" } };
  writeFileSync(path, `${[header, system, ...entries].map((e) => JSON.stringify(e)).join("\n")}\n`);
  const touched = new Date(Date.now() - (options.minutesAgo ?? 30) * 60_000);
  utimesSync(path, touched, touched);
  return path;
}

/** Feed `payload` to this process's stdin, as the Dosu pi extension hands the hook its JSON. */
function hookStdin(payload: unknown): void {
  vi.spyOn(process, "stdin", "get").mockReturnValue(
    Readable.from([JSON.stringify(payload)]) as unknown as typeof process.stdin,
  );
}

/** The `knowledge` arguments the last detached re-spawn was given. */
function respawnedArgs(): string[] {
  const args = (mockSpawn.mock.calls.at(-1) as unknown as [string, string[]])[1];
  return args.slice(args.indexOf("knowledge") + 1);
}

/** What the Dosu pi extension sends on `session_shutdown`. */
function shutdownPayload(id: string, transcript: string, cwd: string, reason = "quit") {
  return {
    hook_event_name: "session_shutdown",
    agent: "pi",
    reason,
    session_id: id,
    transcript_path: transcript,
    cwd,
  };
}

describe("knowledge sync of pi sessions", () => {
  it("ships each finished pi session under its header's id, project and parent", async () => {
    const widget = gitRepo("widget", "git@github.com:acme/widget.git");
    const parent = piSession("01a0fdc5-a112", widget, exchange(1), { minutesAgo: 60 });
    piSession("01a0fdc7-6bbf", widget, [...exchange(1), ...exchange(2)], {
      parentSession: parent,
    });

    await dosu("sync");

    const shipped = Object.fromEntries(posted().map((p) => [String(p.metadata.session_id), p]));
    expect(Object.keys(shipped).sort()).toEqual(["01a0fdc5-a112", "01a0fdc7-6bbf"]);
    expect(shipped["01a0fdc5-a112"].metadata).toMatchObject({
      agent: "pi",
      project: "github.com/acme/widget",
      repo: "github.com/acme/widget",
    });
    expect(shipped["01a0fdc5-a112"].metadata.parent_session_id).toBeUndefined();
    expect(shipped["01a0fdc7-6bbf"].metadata.parent_session_id).toBe("01a0fdc5-a112");
    expect(shipped["01a0fdc5-a112"].records.map((r) => r.role)).toEqual([
      "meta",
      "user",
      "assistant",
      "assistant",
      "tool",
      "assistant",
    ]);
    expect(loadSyncState().sessions["pi/01a0fdc5-a112"]?.outcome).toBe("shipped");
  });

  it("keys a clone with no origin by its root commit", async () => {
    const clone = gitRepo("widget-noorigin");
    piSession("01a0fdc6-3a60", clone, exchange(1));

    await dosu("sync");

    expect(posted().map((p) => p.metadata.project)).toEqual([`git:${rootCommit(clone)}`]);
  });

  it("keeps out a session where the user ran /dosu-incognito, and only such a session", async () => {
    const widget = gitRepo("widget", "git@github.com:acme/widget.git");
    piSession("incognito", widget, [
      ...exchange(1),
      ...exchange(2, "Dosu incognito marker: dosu:incognito:v1\n\nDosu is off for this session."),
    ]);
    // The model reading a file that quotes the marker is not the user opting out.
    const quoting = exchange(3);
    (quoting[2] as { message: { content: { text: string }[] } }).message.content[0].text =
      'export const INCOGNITO_MARKER = "dosu:incognito:v1";';
    piSession("quoting", widget, quoting);

    await dosu("sync");

    expect(posted().map((p) => p.metadata.session_id)).toEqual(["quoting"]);
    expect(loadSyncState().sessions["pi/incognito"]?.outcome).toBe("incognito");
  });
});

describe("knowledge sync from the Dosu pi extension's session_shutdown", () => {
  it("ships the session that just ended, while another live one waits out the quiet period", async () => {
    const widget = gitRepo("widget", "git@github.com:acme/widget.git");
    const ended = piSession("01a0fdc5-a112", widget, exchange(1), { minutesAgo: 0 });
    piSession("live", widget, exchange(2), { minutesAgo: 1 });
    hookStdin(shutdownPayload("01a0fdc5-a112", ended, widget));

    await dosu("sync", "--quiet", "--detach");
    expect(fetchImpl).not.toHaveBeenCalled();
    const child = respawnedArgs();
    expect(child).toEqual(["sync", "--quiet", "--ended", `pi:01a0fdc5-a112=${ended}`]);

    await dosu(...child);
    expect(posted().map((p) => p.metadata.session_id)).toEqual(["01a0fdc5-a112"]);
  });

  it("ships at once a session run under a --session-id pi accepts, dots included", async () => {
    const widget = gitRepo("widget", "git@github.com:acme/widget.git");
    const ended = piSession("rv.task.2", widget, exchange(1), { minutesAgo: 0 });
    hookStdin(shutdownPayload("rv.task.2", ended, widget));

    await dosu("sync", "--quiet", "--detach");
    const child = respawnedArgs();
    expect(child).toEqual(["sync", "--quiet", "--ended", `pi:rv.task.2=${ended}`]);

    await dosu(...child);
    expect(posted().map((p) => p.metadata.session_id)).toEqual(["rv.task.2"]);
  });

  it("ships at once, and keeps finding, a session at an explicit `pi --session <path>`", async () => {
    const widget = gitRepo("widget", "git@github.com:acme/widget.git");
    // Outside every folder the scan walks, under a name of the caller's choosing.
    const dir = join(home, "runs");
    mkdirSync(dir);
    const ended = join(dir, "task-9.jsonl");
    const header = { type: "session", version: 3, id: "01a0ff60-263a", cwd: widget };
    const write = (entries: unknown[]) =>
      writeFileSync(ended, `${[header, ...entries].map((e) => JSON.stringify(e)).join("\n")}\n`);
    write(exchange(1));
    hookStdin(shutdownPayload("01a0ff60-263a", ended, widget));

    await dosu("sync", "--quiet", "--detach");
    await dosu(...respawnedArgs());

    // Resumed later and left to go quiet: a manual sync still knows where it lives.
    write([...exchange(1), ...exchange(2)]);
    const later = new Date(Date.now() - 10 * 60_000);
    utimesSync(ended, later, later);
    await dosu("sync");

    expect(posted().map((p) => [p.metadata.session_id, p.metadata.project])).toEqual([
      ["01a0ff60-263a", "github.com/acme/widget"],
      ["01a0ff60-263a", "github.com/acme/widget"],
    ]);
    expect(posted()[1].metadata.continuation).toMatchObject({ from_record: 6 });
  });

  it("a reload names no session: the extension comes back on the same one", async () => {
    const widget = gitRepo("widget", "git@github.com:acme/widget.git");
    const live = piSession("01a0fdc5-a112", widget, exchange(1), { minutesAgo: 0 });
    hookStdin(shutdownPayload("01a0fdc5-a112", live, widget, "reload"));

    await dosu("sync", "--quiet", "--detach");

    expect(respawnedArgs()).toEqual(["sync", "--quiet"]);
  });

  it("finds a session pi kept under PI_CODING_AGENT_DIR, now and on later runs without it", async () => {
    const widget = gitRepo("widget", "git@github.com:acme/widget.git");
    const agentDir = join(home, "relocated-pi");
    const ended = piSession("01a0fdc5-a112", widget, exchange(1), { minutesAgo: 0, agentDir });
    // The extension's hook runs in pi's environment, so this run has the variable.
    vi.stubEnv("PI_CODING_AGENT_DIR", agentDir);
    fetchImpl.mockResolvedValueOnce(new Response("unavailable", { status: 503 }));
    await dosu("sync", "--quiet", "--ended", `pi:01a0fdc5-a112=${ended}`);

    // A later manual run, past the quiet period, from a shell without the variable still knows
    // where it lives.
    const later = new Date(Date.now() - 10 * 60_000);
    utimesSync(ended, later, later);
    vi.stubEnv("PI_CODING_AGENT_DIR", undefined);
    await dosu("sync");

    expect(posted().map((p) => [p.metadata.session_id, p.metadata.project])).toEqual([
      ["01a0fdc5-a112", "github.com/acme/widget"],
      ["01a0fdc5-a112", "github.com/acme/widget"],
    ]);
    expect(loadSyncState().sessions["pi/01a0fdc5-a112"]?.outcome).toBe("shipped");
  });
});
