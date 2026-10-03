/** `dosu knowledge sync` on Claude Code sessions that spawned subagents: a temporary home with
 * real transcripts (each subagent in its own sidechain file), git checkouts, config, ledger, and
 * project cache, and only the ingest API faked. */

import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { saveConfig } from "../config/config";
import { makeTestConfig } from "../config/config.test-utils";
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
  home = realpathSync(mkdtempSync(join(tmpdir(), "dosu-knowledge-sync-claude-")));
  vi.stubEnv("HOME", home);
  vi.stubEnv("XDG_CONFIG_HOME", join(home, ".config"));
  vi.stubEnv("XDG_DATA_HOME", join(home, ".local", "share"));
  vi.stubEnv("CODEX_HOME", join(home, ".codex"));
  vi.stubEnv("CLAUDE_CONFIG_DIR", undefined);
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
  records: { role: string; content?: string }[];
  metadata: Record<string, unknown>;
}

function posted(): Posted[] {
  return fetchImpl.mock.calls.map(([, init]) => JSON.parse(init?.body as string));
}

function postedBySession(): Record<string, Posted> {
  return Object.fromEntries(posted().map((p) => [p.metadata.session_id as string, p]));
}

/** A git checkout under the temporary home, with one commit and the given origin. */
function gitRepo(name: string, origin: string): string {
  const dir = join(home, "work", name);
  mkdirSync(dir, { recursive: true });
  const git = (...args: string[]) =>
    execFileSync("git", ["-C", dir, "-c", "user.name=t", "-c", "user.email=t@t", ...args], {
      stdio: "ignore",
    });
  git("init", "-q");
  git("remote", "add", "origin", origin);
  git("commit", "-q", "--allow-empty", "-m", "init");
  return dir;
}

type Row = Record<string, unknown>;

/** One user/assistant exchange as Claude Code logs it, big enough to be worth shipping. A
 * subagent's rows are sidechain rows carrying its agent id and its parent's session id. */
function exchange(n: number, cwd: string, extra: Row = {}): Row[] {
  return [
    { type: "user", uuid: `u${n}`, cwd, message: { role: "user", content: `question ${n}` } },
    {
      type: "assistant",
      uuid: `a${n}`,
      message: {
        role: "assistant",
        model: "claude-x",
        content: [{ type: "text", text: `answer ${n}: ${"detail ".repeat(400)}` }],
      },
    },
  ].map((r) => ({ ...r, ...extra, timestamp: `2026-10-02T10:0${n}:00.000Z` }));
}

function jsonl(rows: Row[]): string {
  return `${rows.map((r) => JSON.stringify(r)).join("\n")}\n`;
}

function write(path: string, rows: Row[], minutesAgo: number): string {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, jsonl(rows));
  const touched = new Date(Date.now() - minutesAgo * 60_000);
  utimesSync(path, touched, touched);
  return path;
}

const PROJECTS = () => join(home, ".claude", "projects", "-work");

/** A Claude Code session transcript, last written `minutesAgo` minutes ago. */
function claudeSession(id: string, rows: Row[], minutesAgo: number, root = PROJECTS()): string {
  return write(join(root, `${id}.jsonl`), rows, minutesAgo);
}

/** A subagent's transcript beside its parent session's, as Claude Code writes it. */
function subagent(
  parentId: string,
  agentId: string,
  n: number,
  cwd: string,
  minutesAgo: number,
  root = PROJECTS(),
): string {
  const rows = exchange(n, cwd, { isSidechain: true, agentId, sessionId: parentId });
  return write(join(root, parentId, "subagents", `agent-${agentId}.jsonl`), rows, minutesAgo);
}

describe("knowledge sync of a session with subagents", () => {
  it("ships each subagent as its own session, linked to its parent", async () => {
    const alpha = gitRepo("alpha", "git@github.com:acme/alpha.git");
    claudeSession("parent", exchange(1, alpha, { sessionId: "parent" }), 30);
    subagent("parent", "a1", 2, alpha, 31);

    await dosu("sync");

    const shipped = postedBySession();
    expect(Object.keys(shipped).sort()).toEqual(["agent-a1", "parent"]);
    expect(shipped["agent-a1"].metadata).toMatchObject({
      parent_session_id: "parent",
      agent: "claude-code",
      project: "github.com/acme/alpha",
    });
    expect("parent_session_id" in shipped.parent.metadata).toBe(false);
    // The subagent's own conversation, normalized on its own; the parent's stays its own.
    expect(JSON.stringify(shipped["agent-a1"].records)).toContain("question 2");
    expect(JSON.stringify(shipped["agent-a1"].records)).not.toContain("question 1");
    expect(JSON.stringify(shipped.parent.records)).not.toContain("question 2");

    // Each settled on its own: nothing ships twice.
    await dosu("sync");
    expect(posted()).toHaveLength(2);
  });

  it("ships the subagents of a session that just ended in the same run, past the quiet period", async () => {
    const alpha = gitRepo("alpha", "git@github.com:acme/alpha.git");
    const ended = claudeSession("parent", exchange(1, alpha, { sessionId: "parent" }), 0);
    subagent("parent", "a1", 2, alpha, 0);
    // Another live session's subagent still waits.
    claudeSession("live", exchange(3, alpha, { sessionId: "live" }), 0);
    subagent("live", "b1", 4, alpha, 0);

    await dosu("sync", "--quiet", "--ended", `claude:parent=${ended}`);

    expect(Object.keys(postedBySession()).sort()).toEqual(["agent-a1", "parent"]);
  });

  it("ships a session's subagents under the project the session ended with", async () => {
    const alpha = gitRepo("alpha", "git@github.com:acme/alpha.git");
    const ended = claudeSession("parent", exchange(1, alpha, { sessionId: "parent" }), 0);
    subagent("parent", "a1", 2, alpha, 0);

    vi.stubEnv("DOSU_PROJECT", "poc-alpha");
    await dosu("sync", "--quiet", "--ended", `claude:parent=${ended}`);

    expect(posted().map((p) => p.metadata.project)).toEqual(["poc-alpha", "poc-alpha"]);
  });

  it("keeps the subagents of an incognito session off the record too", async () => {
    const alpha = gitRepo("alpha", "git@github.com:acme/alpha.git");
    const rows = exchange(1, alpha, { sessionId: "parent" });
    rows.push({
      type: "user",
      uuid: "inc",
      message: { role: "user", content: "<command-name>/dosu-incognito</command-name>" },
    });
    claudeSession("parent", rows, 30);
    subagent("parent", "a1", 2, alpha, 31);

    await dosu("sync");

    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("ships the subagents of a session under a relocated config from a shell without it", async () => {
    const alpha = gitRepo("alpha", "git@github.com:acme/alpha.git");
    const relocated = join(home, "altclaude", "projects", "-work");
    const ended = claudeSession(
      "parent",
      exchange(1, alpha, { sessionId: "parent" }),
      0,
      relocated,
    );
    subagent("parent", "a1", 2, alpha, 0, relocated);
    // The hook's run, with the agent's environment, cannot reach the backend.
    fetchImpl.mockResolvedValue(new Response("unavailable", { status: 503 }));
    vi.stubEnv("CLAUDE_CONFIG_DIR", join(home, "altclaude"));
    await dosu("sync", "--quiet", "--ended", `claude:parent=${ended}`);

    // Later, past the quiet period, from a shell that never had the variable.
    const later = new Date(Date.now() - 10 * 60_000);
    for (const path of [ended, join(relocated, "parent", "subagents", "agent-a1.jsonl")]) {
      utimesSync(path, later, later);
    }
    fetchImpl.mockClear();
    fetchImpl.mockResolvedValue(new Response(JSON.stringify({ task_id: "task" }), { status: 202 }));
    vi.stubEnv("CLAUDE_CONFIG_DIR", undefined);
    await dosu("sync");

    expect(Object.keys(postedBySession()).sort()).toEqual(["agent-a1", "parent"]);
  });
});

describe("status views", () => {
  /** Everything printed to stdout by `dosu <args>`, as one string. */
  async function output(...args: string[]): Promise<string> {
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    try {
      await dosu(...args);
      return log.mock.calls.map((c) => c.join(" ")).join("\n");
    } finally {
      log.mockRestore();
    }
  }

  it("count a session and its subagents as one session", async () => {
    const alpha = gitRepo("alpha", "git@github.com:acme/alpha.git");
    claudeSession("parent", exchange(1, alpha, { sessionId: "parent" }), 30);
    subagent("parent", "a1", 2, alpha, 31);
    subagent("parent", "a2", 3, alpha, 32);

    expect(await output("sync")).toContain(
      "Shipped 1 session to Dosu memory (+2 subagent transcripts)",
    );
    const status = await output("sync", "--status");
    expect(status).toMatch(/Shipped: +1 session\n/);
    expect(status).toMatch(/Settled: +1 shipped\n/);
    expect(status).toMatch(/Subagents: +2 shipped\n/);
    expect(await output("sessions", "--shipped")).toContain("Shipped (1)");

    const transcripts = JSON.parse(await output("transcripts", "status", "--json"));
    expect(transcripts).toMatchObject({
      total_shipped: 1,
      counts: { shipped: 1 },
      subagent_counts: { shipped: 2 },
    });
    expect(transcripts.shipped_sessions.map((s: { session: string }) => s.session)).toEqual([
      "claude/parent",
    ]);
  });

  it("list a session's pending subagents with it, not as sessions of their own", async () => {
    const alpha = gitRepo("alpha", "git@github.com:acme/alpha.git");
    claudeSession("parent", exchange(1, alpha, { sessionId: "parent" }), 30);
    subagent("parent", "a1", 2, alpha, 31);

    const queued = JSON.parse(await output("sessions", "--queued", "--json"));
    expect(queued.queued.map((s: { id: string }) => s.id)).toEqual(["parent"]);
    const text = await output("sessions", "--queued");
    expect(text).toContain("Queued (1)");
    expect(text).toContain("1 subagent transcript ships with these sessions");
  });
});
