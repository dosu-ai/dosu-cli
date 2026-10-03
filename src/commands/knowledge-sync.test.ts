/** `dosu knowledge sync` as a hook runs it: a temporary home with real transcripts, git checkouts,
 * config, ledger, and project cache, and only the ingest API faked. */

import { execFileSync } from "node:child_process";
import {
  appendFileSync,
  mkdirSync,
  mkdtempSync,
  realpathSync,
  renameSync,
  rmSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { Readable } from "node:stream";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { saveConfig } from "../config/config";
import { makeTestConfig } from "../config/config.test-utils";
import { INCOGNITO_MARKER } from "../sync/incognito";
import { emptySyncState, saveSyncState } from "../sync/state";
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
  home = realpathSync(mkdtempSync(join(tmpdir(), "dosu-knowledge-sync-")));
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

function posted(): Array<{ records: { role: string }[]; metadata: Record<string, unknown> }> {
  return fetchImpl.mock.calls.map(([, init]) => JSON.parse(init?.body as string));
}

/** Feed `payload` to this process's stdin, as an agent hands a hook its JSON. */
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

/** One user/assistant exchange as Claude Code logs it, big enough to be worth shipping. */
function exchange(n: number, cwd: string): string {
  return `${[
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
  ]
    .map((r) => JSON.stringify({ ...r, sessionId: "s", timestamp: `2026-10-02T10:0${n}:00.000Z` }))
    .join("\n")}\n`;
}

/** A Claude Code transcript under the temporary home, last written `minutesAgo` minutes ago. */
function claudeSession(id: string, body: string, minutesAgo: number): string {
  const dir = join(home, ".claude", "projects", "-work");
  mkdirSync(dir, { recursive: true });
  const path = join(dir, `${id}.jsonl`);
  writeFileSync(path, body);
  const touched = new Date(Date.now() - minutesAgo * 60_000);
  utimesSync(path, touched, touched);
  return path;
}

/** A Codex rollout under the temporary CODEX_HOME, last written `minutesAgo` minutes ago. */
function codexRollout(
  name: string,
  cwd: string,
  minutesAgo: number,
  meta: Record<string, unknown> = {},
  prompt = "question",
): string {
  const dir = join(home, ".codex", "sessions", "2026", "10", "02");
  mkdirSync(dir, { recursive: true });
  const path = join(dir, `${name}.jsonl`);
  const at = "2026-10-02T10:00:00.000Z";
  const records = [
    {
      type: "session_meta",
      payload: { id: name.slice(-36), timestamp: at, cwd, cli_version: "0.160.0", ...meta },
    },
    {
      type: "response_item",
      payload: {
        type: "message",
        role: "user",
        content: [{ type: "input_text", text: prompt }],
      },
    },
    {
      type: "response_item",
      payload: {
        type: "message",
        role: "assistant",
        content: [{ type: "output_text", text: `answer: ${"detail ".repeat(400)}` }],
      },
    },
  ];
  writeFileSync(
    path,
    `${records.map((r) => JSON.stringify({ timestamp: at, ...r })).join("\n")}\n`,
  );
  const touched = new Date(Date.now() - minutesAgo * 60_000);
  utimesSync(path, touched, touched);
  return path;
}

describe("knowledge sync from a session-end hook", () => {
  it("applies the hook's DOSU_PROJECT to the session that ended, and to no other", async () => {
    const alpha = gitRepo("alpha", "git@github.com:acme/alpha.git");
    const beta = gitRepo("beta", "git@github.com:acme/beta.git");
    const ended = claudeSession("aaaa", exchange(1, alpha), 0);
    // An older session from another checkout, still waiting to ship.
    claudeSession("bbbb", exchange(2, beta), 60);

    // The hook, and so this sync, runs in the environment of the agent that just ended.
    vi.stubEnv("DOSU_PROJECT", "poc-alpha");
    await dosu("sync", "--quiet", "--ended", `claude:aaaa=${ended}`);

    const projects = Object.fromEntries(
      posted().map((p) => [p.metadata.session_id, p.metadata.project]),
    );
    expect(projects).toEqual({ aaaa: "poc-alpha", bbbb: "github.com/acme/beta" });
  });

  it("the ended session keeps the hook's project when a later run, without it, ships it", async () => {
    const alpha = gitRepo("alpha", "git@github.com:acme/alpha.git");
    const ended = claudeSession("aaaa", exchange(1, alpha), 0);
    fetchImpl.mockResolvedValueOnce(new Response("unavailable", { status: 503 }));

    vi.stubEnv("DOSU_PROJECT", "poc-alpha");
    await dosu("sync", "--quiet", "--ended", `claude:aaaa=${ended}`);
    // Later, past the quiet period, a manual run from a shell without the variable.
    const later = new Date(Date.now() - 10 * 60_000);
    utimesSync(ended, later, later);
    vi.stubEnv("DOSU_PROJECT", undefined);
    await dosu("sync");

    expect(posted().map((p) => p.metadata.project)).toEqual(["poc-alpha", "poc-alpha"]);
  });

  it("the --detach parent hands the SessionEnd payload's session to the run it spawns", async () => {
    const alpha = gitRepo("alpha", "git@github.com:acme/alpha.git");
    const ended = claudeSession("aaaa", exchange(1, alpha), 0);
    claudeSession("live", exchange(2, alpha), 1);
    hookStdin({
      hook_event_name: "SessionEnd",
      session_id: "aaaa",
      transcript_path: ended,
      cwd: alpha,
      reason: "exit",
    });

    await dosu("sync", "--quiet", "--detach");
    expect(fetchImpl).not.toHaveBeenCalled();
    const child = respawnedArgs();
    expect(child).toEqual(["sync", "--quiet", "--ended", `claude:aaaa=${ended}`]);

    // The spawned run ships the session that ended; the live one waits out the quiet period.
    await dosu(...child);
    expect(posted().map((p) => p.metadata.session_id)).toEqual(["aaaa"]);
  });

  it("a hook's session and an explicit --ended-path stay two sessions, each with its transcript", async () => {
    const alpha = gitRepo("alpha", "git@github.com:acme/alpha.git");
    // Outside the scanned roots, so only the paths say where each session lives.
    const relocated = join(home, "altcfg", "projects", "-work");
    mkdirSync(relocated, { recursive: true });
    const ended = join(relocated, "aaaa.jsonl");
    writeFileSync(ended, exchange(1, alpha));
    const other = join(home, "elsewhere", "other.jsonl");
    mkdirSync(join(home, "elsewhere"));
    writeFileSync(other, exchange(2, alpha));
    hookStdin({ hook_event_name: "SessionEnd", session_id: "aaaa", transcript_path: ended });

    await dosu("sync", "--quiet", "--detach", "--ended-path", other);
    await dosu(...respawnedArgs());

    const [shipped] = posted();
    expect(shipped.metadata.session_id).toBe("aaaa");
    expect(JSON.stringify(shipped.records)).toContain("question 1");
    expect(JSON.stringify(shipped.records)).not.toContain("question 2");
  });

  it("ships the session a Codex SessionEnd names at once, under its rollout's name", async () => {
    const alpha = gitRepo("alpha", "git@github.com:acme/alpha.git");
    const uuid = "01a0ff29-62b1-7310-94a2-45a5c2140458";
    const ended = codexRollout(`rollout-2026-10-02T17-28-17-${uuid}`, alpha, 0);
    codexRollout("rollout-2026-10-02T17-29-00-01a0ff2a-0000-7000-8000-000000000000", alpha, 1);
    hookStdin({
      session_id: uuid,
      transcript_path: ended,
      cwd: alpha,
      hook_event_name: "SessionEnd",
      reason: "other",
    });

    await dosu("sync", "--quiet", "--detach");
    const child = respawnedArgs();
    expect(child).toEqual([
      "sync",
      "--quiet",
      "--ended",
      `codex:rollout-2026-10-02T17-28-17-${uuid}=${ended}`,
    ]);
    await dosu(...child);

    expect(posted().map((p) => p.metadata)).toEqual([
      expect.objectContaining({
        agent: "codex",
        session_id: `rollout-2026-10-02T17-28-17-${uuid}`,
        project: "github.com/acme/alpha",
      }),
    ]);
  });

  it("a per-turn hook payload names no session, so nothing skips the quiet period", async () => {
    hookStdin({ hook_event_name: "Stop", session_id: "aaaa", transcript_path: "/x/aaaa.jsonl" });

    await dosu("sync", "--quiet", "--detach");

    expect(respawnedArgs()).toEqual(["sync", "--quiet"]);
  });
});

describe("knowledge sync of Codex subagents", () => {
  it("ships a subagent's session with its parent's rollout as parent_session_id", async () => {
    const alpha = gitRepo("alpha", "git@github.com:acme/alpha.git");
    const parent = "rollout-2026-10-02T17-33-20-01a0ff2e-029b-7153-9702-1dbfdee28612";
    codexRollout(parent, alpha, 30);
    codexRollout("rollout-2026-10-02T17-33-26-01a0ff2e-1861-7b61-a549-34bdff8539e0", alpha, 30, {
      parent_thread_id: "01a0ff2e-029b-7153-9702-1dbfdee28612",
      thread_source: "subagent",
    });

    await dosu("sync");

    expect(
      Object.fromEntries(
        posted().map((p) => [p.metadata.session_id, p.metadata.parent_session_id]),
      ),
    ).toEqual({
      [parent]: undefined,
      "rollout-2026-10-02T17-33-26-01a0ff2e-1861-7b61-a549-34bdff8539e0": parent,
    });
  });
});

describe("knowledge sync of an incognito Codex session's descendants", () => {
  it("keeps its subagents and its forks off the record, which carry no marker of their own", async () => {
    const alpha = gitRepo("alpha", "git@github.com:acme/alpha.git");
    const parentId = "01a0ff74-a68d-7ad0-83ee-80cf02c29b14";
    const parent = codexRollout(
      `rollout-2026-10-02T18-50-30-${parentId}`,
      alpha,
      30,
      {},
      `${INCOGNITO_MARKER} keep this one out`,
    );
    // Archived since: found there all the same.
    mkdirSync(join(home, ".codex", "archived_sessions"));
    renameSync(parent, join(home, ".codex", "archived_sessions", basename(parent)));
    const subagent = "rollout-2026-10-02T18-50-38-01a0ff74-c903-73c2-b6b1-7546b84710ff";
    codexRollout(subagent, alpha, 30, { parent_thread_id: parentId, thread_source: "subagent" });
    const fork = "rollout-2026-10-02T18-56-30-01a0ff7a-277c-74f1-b64b-59ffa01a7d14";
    codexRollout(fork, alpha, 30, { forked_from_id: parentId, thread_source: "user" });
    // A fork of the subagent: off the record two links up.
    codexRollout("rollout-2026-10-02T19-00-00-01a0ff7d-0000-7000-8000-000000000001", alpha, 30, {
      forked_from_id: "01a0ff74-c903-73c2-b6b1-7546b84710ff",
    });
    const other = "rollout-2026-10-02T19-10-00-01a0ff86-0000-7000-8000-000000000002";
    codexRollout(other, alpha, 30);

    await dosu("sync");

    expect(posted().map((p) => p.metadata.session_id)).toEqual([other]);
  });
});

describe("knowledge sync of Codex subagents, ended", () => {
  it("ships a session's subagents with it: Codex ends them with the session it names", async () => {
    const alpha = gitRepo("alpha", "git@github.com:acme/alpha.git");
    const uuid = "01a0ff53-4a89-7920-bc32-11dac880a6e6";
    const parent = codexRollout(`rollout-2026-10-02T18-14-03-${uuid}`, alpha, 0);
    codexRollout("rollout-2026-10-02T18-14-12-01a0ff53-6b7f-7932-813b-526f14d8b881", alpha, 0, {
      parent_thread_id: uuid,
      thread_source: "subagent",
    });

    await dosu("sync", "--quiet", "--ended", `codex:rollout-2026-10-02T18-14-03-${uuid}=${parent}`);

    expect(
      posted()
        .map((p) => p.metadata.session_id)
        .sort(),
    ).toEqual([
      `rollout-2026-10-02T18-14-03-${uuid}`,
      "rollout-2026-10-02T18-14-12-01a0ff53-6b7f-7932-813b-526f14d8b881",
    ]);
  });
});

describe("knowledge sync of a resumed session", () => {
  it("ships the tail of one under a relocated Claude config from a shell without the variable", async () => {
    const alpha = gitRepo("alpha", "git@github.com:acme/alpha.git");
    const relocated = join(home, "altclaude");
    mkdirSync(join(relocated, "projects", "-work"), { recursive: true });
    const path = join(relocated, "projects", "-work", "aaaa.jsonl");
    writeFileSync(path, exchange(1, alpha));
    // The session-end hook runs in the agent's environment, which has the variable.
    vi.stubEnv("CLAUDE_CONFIG_DIR", relocated);
    await dosu("sync", "--quiet", "--ended", `claude:aaaa=${path}`);

    appendFileSync(path, exchange(2, alpha));
    const later = new Date(Date.now() - 10 * 60_000);
    utimesSync(path, later, later);
    vi.stubEnv("CLAUDE_CONFIG_DIR", undefined);
    await dosu("sync");

    const [, second] = posted();
    expect(second?.metadata).toMatchObject({ session_id: "aaaa", continuation: expect.anything() });
  });

  it("ships only the new tail the second time", async () => {
    const alpha = gitRepo("alpha", "git@github.com:acme/alpha.git");
    const path = claudeSession("aaaa", exchange(1, alpha), 30);
    await dosu("sync");

    appendFileSync(path, exchange(2, alpha));
    const later = new Date(Date.now() - 10 * 60_000);
    utimesSync(path, later, later);
    await dosu("sync");

    const [first, second] = posted();
    expect(first.metadata.continuation).toBeUndefined();
    expect(second.metadata.continuation).toEqual({
      from_record: first.records.length,
      prefix_sha256: expect.stringMatching(/^[0-9a-f]{64}$/),
    });
    expect(second.records.map((r) => r.role)).toEqual(["meta", "user", "assistant"]);
  });
});

describe("knowledge sync --status", () => {
  it("summarizes many sessions passed over for one reason instead of listing each", async () => {
    const entry = (outcome: "unsupported" | "rejected", message: string) => ({
      updated: "2026-10-01T00:00:00.000Z",
      outcome,
      at: "2026-10-01T00:05:00.000Z",
      cli_version: "1.0.0",
      message,
    });
    const sessions = Object.fromEntries(
      Array.from({ length: 12 }, (_, i) => [
        `opencode/ses_${i}`,
        entry("unsupported", "no normalizer for opencode sessions yet"),
      ]),
    );
    sessions["claude/refused"] = entry("rejected", "ingest rejected: HTTP 422");
    saveSyncState({ ...emptySyncState(), sessions });
    const log = vi.spyOn(console, "log").mockImplementation(() => {});

    await dosu("sync", "--status");

    const out = log.mock.calls.map((c) => c.join(" ")).join("\n");
    expect(out).toContain("rejected    claude/refused \u00B7 ingest rejected: HTTP 422");
    expect(out).toContain("unsupported 12 sessions \u00B7 no normalizer for opencode sessions yet");
    expect(out).toContain("+9 more");
    expect(out).toContain("dosu knowledge sessions --unsupported");
    expect(out.split("\n").filter((line) => line.includes("opencode/ses_"))).toHaveLength(1);
  });
});
