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
import { loadSyncState } from "../sync/state";
import { SHIP_BATCH_LIMIT } from "../sync/sync";
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

  it("ships a workflow's agents as subagents of the session that ran it", async () => {
    const alpha = gitRepo("alpha", "git@github.com:acme/alpha.git");
    const ended = claudeSession("parent", exchange(1, alpha, { sessionId: "parent" }), 0);
    const rows = exchange(2, alpha, { isSidechain: true, agentId: "w1", sessionId: "parent" });
    write(join(PROJECTS(), "parent", "subagents", "workflows", "wf_1", "agent-w1.jsonl"), rows, 0);

    await dosu("sync", "--quiet", "--ended", `claude:parent=${ended}`);

    const shipped = postedBySession();
    expect(Object.keys(shipped).sort()).toEqual(["agent-w1", "parent"]);
    expect(shipped["agent-w1"].metadata.parent_session_id).toBe("parent");
    expect(JSON.stringify(shipped["agent-w1"].records)).toContain("question 2");
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

  it("ships a session that just ended with all its subagents, however many, before the backlog", async () => {
    const alpha = gitRepo("alpha", "git@github.com:acme/alpha.git");
    // An older backlog session, and more subagents than one run's batch, all finished before
    // the session that just ended wrote its last line.
    claudeSession("older", exchange(1, alpha, { sessionId: "older" }), 60);
    const ended = claudeSession("parent", exchange(2, alpha, { sessionId: "parent" }), 0);
    const agents = Array.from({ length: SHIP_BATCH_LIMIT + 2 }, (_, i) => `a${i}`);
    for (const agent of agents) subagent("parent", agent, 3, alpha, 2);

    await dosu("sync", "--quiet", "--ended", `claude:parent=${ended}`);

    const order = posted().map((p) => p.metadata.session_id);
    // Nothing runs after a throwaway machine's last session ends: this run is its only chance.
    expect(order[0]).toBe("parent");
    expect(order.slice(1).sort()).toEqual(agents.map((a) => `agent-${a}`).sort());
  });

  it("tries a session that just ended before its subagents while hook runs back off", async () => {
    const alpha = gitRepo("alpha", "git@github.com:acme/alpha.git");
    const ended = claudeSession("parent", exchange(1, alpha, { sessionId: "parent" }), 0);
    subagent("parent", "a1", 2, alpha, 2);
    // An earlier hook run failed, so this one is inside the backoff and tries only ended work.
    fetchImpl.mockResolvedValue(new Response("unavailable", { status: 503 }));
    claudeSession("before", exchange(3, alpha, { sessionId: "before" }), 30);
    await dosu("sync", "--quiet");
    fetchImpl.mockClear();
    // The backend takes the session but not the subagent's transcript.
    fetchImpl.mockImplementation(async (_url, init) =>
      JSON.parse(init?.body as string).metadata.session_id === "parent"
        ? new Response(JSON.stringify({ task_id: "task" }), { status: 202 })
        : new Response("unavailable", { status: 503 }),
    );

    await dosu("sync", "--quiet", "--ended", `claude:parent=${ended}`);

    expect(posted()[0].metadata.session_id).toBe("parent");
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

  it("holds a subagent's transcript while its session is live, so the session can still opt out", async () => {
    const alpha = gitRepo("alpha", "git@github.com:acme/alpha.git");
    const rows = exchange(1, alpha, { sessionId: "parent" });
    const live = claudeSession("parent", rows, 0);
    // The subagent finished long ago; the session it worked for is still going.
    subagent("parent", "a1", 2, alpha, 10);

    // Any hook run (another session ending, another agent's per-turn hook) leaves it alone.
    await dosu("sync", "--quiet");
    expect(fetchImpl).not.toHaveBeenCalled();

    // Then the user turns Dosu off for the session, and the session ends.
    rows.push({
      type: "user",
      uuid: "inc",
      message: { role: "user", content: "<command-name>/dosu-incognito</command-name>" },
    });
    claudeSession("parent", rows, 0);
    await dosu("sync", "--quiet", "--ended", `claude:parent=${live}`);

    expect(fetchImpl).not.toHaveBeenCalled();
    const { sessions } = loadSyncState();
    expect(sessions["claude/parent"].outcome).toBe("incognito");
    expect(sessions["claude/agent-a1"].outcome).toBe("incognito");
  });

  it("ships a subagent's transcript once its session has gone quiet, without an end hook", async () => {
    const alpha = gitRepo("alpha", "git@github.com:acme/alpha.git");
    claudeSession("parent", exchange(1, alpha, { sessionId: "parent" }), 0);
    subagent("parent", "a1", 2, alpha, 10);
    await dosu("sync", "--quiet");
    expect(fetchImpl).not.toHaveBeenCalled();

    // Quiet for the full period (as after `claude -p --bare`, which runs no hooks).
    const quiet = new Date(Date.now() - 6 * 60_000);
    utimesSync(join(PROJECTS(), "parent.jsonl"), quiet, quiet);
    await dosu("sync", "--quiet");

    expect(Object.keys(postedBySession()).sort()).toEqual(["agent-a1", "parent"]);
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

describe("knowledge sync of a session with a background agent", () => {
  it("keeps the agent's reported result in the session, and ships the agent's own work linked to it", async () => {
    const alpha = gitRepo("alpha", "git@github.com:acme/alpha.git");
    const rows = exchange(1, alpha, { sessionId: "parent" });
    rows.push(
      {
        type: "user",
        uuid: "n1",
        sessionId: "parent",
        timestamp: "2026-10-02T10:05:00.000Z",
        origin: { kind: "task-notification" },
        message: {
          role: "user",
          content:
            "<task-notification>\n<task-id>a1</task-id>\n<status>completed</status>\n" +
            "<result>The flaky test is test_retry: it sleeps on wall-clock time.</result>\n" +
            "</task-notification>",
        },
      },
      ...exchange(6, alpha, { sessionId: "parent" }).slice(1),
    );
    claudeSession("parent", rows, 30);
    subagent("parent", "a1", 2, alpha, 31);

    await dosu("sync");

    const shipped = postedBySession();
    const observed = shipped.parent.records.filter((r) => r.role === "observation");
    expect(observed.map((r) => r.content)).toEqual([
      expect.stringContaining("The flaky test is test_retry"),
    ]);
    expect(shipped.parent.records.map((r) => r.role)).toEqual([
      "meta",
      "user",
      "assistant",
      "observation",
      "assistant",
    ]);
    expect(shipped["agent-a1"].metadata.parent_session_id).toBe("parent");
  });

  it("keeps a result Claude Code queued while the session was busy", async () => {
    const alpha = gitRepo("alpha", "git@github.com:acme/alpha.git");
    const rows = exchange(1, alpha, { sessionId: "parent" });
    rows.push(
      // The usual delivery in an interactive session: the agent finished mid-turn, so the
      // notification waited in the queue and was logged as an attachment, not a user message.
      {
        type: "attachment",
        uuid: "q1",
        sessionId: "parent",
        isSidechain: false,
        timestamp: "2026-10-02T10:05:00.000Z",
        attachment: {
          type: "queued_command",
          commandMode: "task-notification",
          prompt:
            "<task-notification>\n<task-id>a1</task-id>\n<status>completed</status>\n" +
            "<result>The flaky test is test_retry: it sleeps on wall-clock time.</result>\n" +
            "</task-notification>",
        },
      },
      ...exchange(6, alpha, { sessionId: "parent" }).slice(1),
    );
    claudeSession("parent", rows, 30);
    subagent("parent", "a1", 2, alpha, 31);

    await dosu("sync");

    const { parent } = postedBySession();
    expect(parent.records.map((r) => r.role)).toEqual([
      "meta",
      "user",
      "assistant",
      "observation",
      "assistant",
    ]);
    expect(parent.records[3].content).toContain("The flaky test is test_retry");
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

  it("say what became of every subagent transcript a run settled, not only the shipped ones", async () => {
    const alpha = gitRepo("alpha", "git@github.com:acme/alpha.git");
    claudeSession("parent", exchange(1, alpha, { sessionId: "parent" }), 30);
    subagent("parent", "a1", 2, alpha, 31);
    subagent("parent", "a2", 3, alpha, 32);
    // Too small to learn from.
    const short = exchange(4, alpha, { isSidechain: true, agentId: "a3", sessionId: "parent" });
    short[1] = { ...short[1], message: { role: "assistant", content: "ok" } };
    write(join(PROJECTS(), "parent", "subagents", "agent-a3.jsonl"), short, 33);
    // The backend refuses one transcript.
    fetchImpl.mockImplementation(async (_url, init) =>
      JSON.parse(init?.body as string).metadata.session_id === "agent-a2"
        ? new Response("bad payload", { status: 422 })
        : new Response(JSON.stringify({ task_id: "task" }), { status: 202 }),
    );

    const said = await output("sync");

    expect(said).toContain("Shipped 1 session to Dosu memory (+1 subagent transcript)");
    expect(said).toContain("Subagent transcripts passed over: 1 trivial · 1 rejected");
    expect(await output("sync", "--status")).toMatch(
      /Subagents: +1 shipped · 1 trivial · 1 rejected\n/,
    );
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
