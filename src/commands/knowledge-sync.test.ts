/** `dosu knowledge sync` as a hook runs it: a temporary home with real transcripts, git checkouts,
 * config, ledger, and project cache, and only the ingest API faked. */

import { execFileSync } from "node:child_process";
import {
  appendFileSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, delimiter, dirname, join } from "node:path";
import { Readable } from "node:stream";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { saveConfig } from "../config/config";
import { makeTestConfig } from "../config/config.test-utils";
import { contextHookOutput } from "../memory/context-hook";
import { makeOpencodeDb, opencodeDocument } from "../sessions/opencode.test-utils";
import { INCOGNITO_MARKER } from "../sync/incognito";
import { lockPath } from "../sync/lock";
import { emptySyncState, loadSyncState, saveSyncState, syncStatePath } from "../sync/state";
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

describe("knowledge sync of a Codex session that ran $dosu-incognito", () => {
  it("settles it as incognito: Codex hands the model the installed skill, marker and all", async () => {
    const alpha = gitRepo("alpha", "git@github.com:acme/alpha.git");
    // `off` installs the skill without putting Codex in incognito, which would settle both.
    await dosu("incognito", "off", "codex");
    const skill = join(home, ".codex", "skills", "dosu-incognito", "SKILL.md");
    // The user turn Codex 0.140 and 0.160 record when the user mentions the skill.
    const injected = `<skill>\n<name>dosu-incognito</name>\n<path>${skill}</path>\n${readFileSync(skill, "utf-8")}\n</skill>`;
    const off = "rollout-2026-10-02T21-39-11-01a1000f-16ad-74a1-89da-48c26a9f5e74";
    codexRollout(off, alpha, 30, {}, injected);
    const on = "rollout-2026-10-02T21-39-30-01a1000f-6111-7ca2-a4ff-a4662c9f0a1c";
    codexRollout(on, alpha, 30);

    await dosu("sync");

    expect(posted().map((p) => p.metadata.session_id)).toEqual([on]);
    expect(loadSyncState().sessions[`codex/${off}`]?.outcome).toBe("incognito");
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

describe("knowledge sync of what descends from a session its agent's switch settled", () => {
  it("keeps a Codex fork or subagent made once the switch is off out, though no marker says so", async () => {
    const alpha = gitRepo("alpha", "git@github.com:acme/alpha.git");
    const sourceId = "01a0ff74-a68d-7ad0-83ee-80cf02c29b14";
    const source = `rollout-2026-10-02T18-50-30-${sourceId}`;
    codexRollout(source, alpha, 30, {}, "SECRET incognito work");
    await dosu("incognito", "on", "codex");
    await dosu("sync");
    await dosu("incognito", "off", "codex");
    expect(loadSyncState().sessions[`codex/${source}`]?.by_agent).toBe(true);

    // Made after `off`: a fork (Codex /fork) and a subagent of the session, and a fork of that.
    const fork = "rollout-2026-10-02T18-56-30-01a0ff7a-277c-74f1-b64b-59ffa01a7d14";
    codexRollout(fork, alpha, 20, { forked_from_id: sourceId, thread_source: "user" });
    const subagentId = "01a0ff74-c903-73c2-b6b1-7546b84710ff";
    const subagent = `rollout-2026-10-02T18-50-38-${subagentId}`;
    codexRollout(subagent, alpha, 20, { parent_thread_id: sourceId, thread_source: "subagent" });
    const forkOfSubagent = "rollout-2026-10-02T19-00-00-01a0ff7d-0000-7000-8000-000000000001";
    codexRollout(forkOfSubagent, alpha, 20, { forked_from_id: subagentId });
    const other = "rollout-2026-10-02T19-10-00-01a0ff86-0000-7000-8000-000000000002";
    codexRollout(other, alpha, 20);

    await dosu("sync");

    expect(posted().map((p) => p.metadata.session_id)).toEqual([other]);
    const sessions = loadSyncState().sessions;
    for (const key of [fork, subagent, forkOfSubagent]) {
      expect(sessions[`codex/${key}`]).toMatchObject({ outcome: "incognito", by_agent: true });
    }
  });

  it("keeps a Claude Code branch of it out, which copies its history under a new id", async () => {
    const alpha = gitRepo("alpha", "git@github.com:acme/alpha.git");
    const original = claudeSession("orig", exchange(1, alpha), 30);
    await dosu("incognito", "on", "claude");
    await dosu("sync");
    await dosu("incognito", "off", "claude");
    expect(loadSyncState().sessions["claude/orig"]?.by_agent).toBe(true);

    // `/branch` (or `claude -r orig --fork-session`): every record of the session, re-stamped with
    // the branch's id and tagged with the one it came from, then the branch's own turns.
    const copied = readFileSync(original, "utf-8")
      .trim()
      .split("\n")
      .map((line) => {
        const record = JSON.parse(line);
        const forkedFrom = { sessionId: "orig", messageUuid: record.uuid };
        return JSON.stringify({ ...record, sessionId: "branch", forkedFrom });
      });
    claudeSession("branch", `${copied.join("\n")}\n${exchange(2, alpha)}`, 20);
    claudeSession("other", exchange(3, alpha), 20);

    await dosu("sync");

    expect(posted().map((p) => p.metadata.session_id)).toEqual(["other"]);
    expect(loadSyncState().sessions["claude/branch"]).toMatchObject({
      outcome: "incognito",
      by_agent: true,
    });
  });
});

describe("knowledge sync of a session its agent's switch settled, long after", () => {
  it("still keeps it out when it is resumed months later, its entry kept all the while", async () => {
    const alpha = gitRepo("alpha", "git@github.com:acme/alpha.git");
    const sealed = "rollout-2026-10-02T18-50-30-01a0ff74-a68d-7ad0-83ee-80cf02c29b14";
    const path = codexRollout(sealed, alpha, 30, {}, "SECRET incognito work");
    await dosu("incognito", "on", "codex");
    await dosu("sync");
    await dosu("incognito", "off", "codex");
    // Then left alone for 40 days: past the scan window and the week of grace after it.
    const longAgo = new Date(Date.now() - 40 * 24 * 60 * 60_000);
    utimesSync(path, longAgo, longAgo);
    const state = loadSyncState();
    state.sessions[`codex/${sealed}`].updated = longAgo.toISOString();
    saveSyncState(state);
    // A sync that ships something else prunes the ledger.
    claudeSession("other", exchange(1, alpha), 30);
    await dosu("sync");
    expect(loadSyncState().sessions[`codex/${sealed}`]?.by_agent).toBe(true);

    appendFileSync(path, `${JSON.stringify({ type: "event_msg", payload: { type: "x" } })}\n`);
    utimesSync(path, new Date(Date.now() - 10 * 60_000), new Date(Date.now() - 10 * 60_000));
    await dosu("sync");

    expect(posted().map((p) => p.metadata.session_id)).toEqual(["other"]);
  });
});

describe("knowledge sync, first after an upgrade from 0.66", () => {
  it("keeps out what 0.66's watermark passed over unstudied, an incognito agent's included", async () => {
    const alpha = gitRepo("alpha", "git@github.com:acme/alpha.git");
    const day = 24 * 60;
    // Ran while Claude Code was incognito on 0.66, which then had the switch turned off.
    claudeSession("incognito-then", exchange(1, alpha), 2 * day);
    claudeSession("studied", exchange(2, alpha), 2 * day);
    // Ran after 0.66's last sync: its watermark never passed it.
    claudeSession("since", exchange(3, alpha), 60);
    const watermark = new Date(Date.now() - day * 60_000).toISOString();
    mkdirSync(dirname(syncStatePath()), { recursive: true });
    writeFileSync(
      syncStatePath(),
      JSON.stringify({
        schema_version: 1,
        watermark,
        consecutive_failures: 0,
        mined_sessions: [{ at: watermark, session: "claude/studied" }],
        total_mined: 1,
      }),
    );

    await dosu("sync");

    expect(
      posted()
        .map((p) => p.metadata.session_id)
        .sort(),
    ).toEqual(["since", "studied"]);
    const state = loadSyncState();
    expect(state.sessions["claude/incognito-then"]).toMatchObject({ by_agent: true });
    expect(state.legacy_passed).toBeUndefined();
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

describe("knowledge sync from opencode's Dosu plugin", () => {
  // Whatever opencode this machine has never answers: every document comes from the DB rows under
  // the temporary home, and no real opencode boots against them.
  beforeEach(() => {
    const bin = join(home, "bin");
    mkdirSync(bin);
    writeFileSync(join(bin, "opencode"), "#!/bin/sh\nexit 1\n", { mode: 0o755 });
    vi.stubEnv("PATH", `${bin}${delimiter}${process.env.PATH ?? ""}`);
  });

  /** opencode sessions in its DB under the temporary home, all still inside the quiet period. */
  function opencodeSessions(dir: string): boolean {
    mkdirSync(join(home, ".local", "share", "opencode"), { recursive: true });
    const answer = `answer: ${"detail ".repeat(400)}`;
    const updated = Date.now();
    return makeOpencodeDb(join(home, ".local", "share", "opencode", "opencode.db"), [
      opencodeDocument({ id: "ses_root", directory: dir, answer, updated }),
      opencodeDocument({ id: "ses_child", parentID: "ses_root", directory: dir, answer, updated }),
      opencodeDocument({ id: "ses_live", directory: dir, answer, updated }),
    ]);
  }

  it("ships the sessions the plugin reports ended when opencode exits, a subagent's naming its parent", async () => {
    const alpha = gitRepo("alpha", "git@github.com:acme/alpha.git");
    if (!opencodeSessions(alpha)) return; // no sqlite builtin

    // The plugin's watcher names every session that ran in the process, with nothing on stdin.
    vi.spyOn(process, "stdin", "get").mockReturnValue(
      Readable.from([]) as unknown as typeof process.stdin,
    );
    const ended = ["--ended", "opencode:ses_root", "--ended", "opencode:ses_child"];
    await dosu("sync", "--quiet", "--detach", ...ended);
    const child = respawnedArgs();
    expect(child).toEqual(["sync", "--quiet", ...ended]);
    await dosu(...child);

    // The session still running elsewhere waits out the quiet period.
    expect(posted().map((p) => p.metadata)).toEqual([
      expect.objectContaining({
        agent: "opencode",
        session_id: "ses_root",
        project: "github.com/acme/alpha",
      }),
      expect.objectContaining({
        agent: "opencode",
        session_id: "ses_child",
        parent_session_id: "ses_root",
      }),
    ]);
    expect(posted()[0].records[0]).toMatchObject({ role: "meta", source: "opencode", cwd: alpha });
  });

  it("applies opencode's DOSU_PROJECT to the sessions that ended there, a subagent's included", async () => {
    const alpha = gitRepo("alpha", "git@github.com:acme/alpha.git");
    if (!opencodeSessions(alpha)) return;

    // The plugin's syncs run in the opencode process's environment.
    vi.stubEnv("DOSU_PROJECT", "poc-alpha");
    await dosu("sync", "--quiet", "--ended", "opencode:ses_root", "--ended", "opencode:ses_child");
    // Later, past the quiet period, a run from a shell without the variable ships the rest.
    vi.stubEnv("DOSU_PROJECT", undefined);
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(Date.now() + 10 * 60_000);
    await dosu("sync");
    vi.useRealTimers();

    const projects = Object.fromEntries(
      posted().map((p) => [p.metadata.session_id, p.metadata.project]),
    );
    expect(projects).toEqual({
      ses_root: "poc-alpha",
      ses_child: "poc-alpha",
      ses_live: "github.com/acme/alpha",
    });
  });
});

/** Unix seconds `n` minutes ago. */
const minutesAgo = (n: number) => Math.floor((Date.now() - n * 60_000) / 1000);

/** `git` in `dir` as though run at unix second `at`: the reflog records each checkout then. */
function gitAt(dir: string, at: number, ...args: string[]): void {
  const date = `@${at} +0000`;
  execFileSync("git", ["-C", dir, "-c", "user.name=t", "-c", "user.email=t@t", ...args], {
    env: { ...process.env, GIT_COMMITTER_DATE: date, GIT_AUTHOR_DATE: date },
    stdio: "ignore",
  });
}

/** A checkout made an hour before `since`, that moved to `branch` at `since`. */
function checkoutOn(name: string, branch: string, since: number): string {
  const dir = join(home, "work", name);
  mkdirSync(dir, { recursive: true });
  gitAt(dir, since - 3600, "init", "-q");
  gitAt(dir, since - 3600, "remote", "add", "origin", `git@github.com:acme/${name}.git`);
  gitAt(dir, since - 3600, "commit", "-q", "--allow-empty", "-m", "init");
  gitAt(dir, since, "checkout", "-q", "-b", branch);
  return dir;
}

describe("knowledge sync of a session's branch", () => {
  it("ships an opencode session with the branch it began on, not one it or the checkout moved to later", async () => {
    const bin = join(home, "bin");
    mkdirSync(bin);
    writeFileSync(join(bin, "opencode"), "#!/bin/sh\nexit 1\n", { mode: 0o755 });
    vi.stubEnv("PATH", `${bin}${delimiter}${process.env.PATH ?? ""}`);
    // The fixture's prompt is at this second.
    const prompted = Math.floor(opencodeDocument().messages[0].info.time.created / 1000);
    const alpha = checkoutOn("alpha", "feat/layout", prompted - 600);
    mkdirSync(join(home, ".local", "share", "opencode"), { recursive: true });
    const made = makeOpencodeDb(join(home, ".local", "share", "opencode", "opencode.db"), [
      opencodeDocument({
        id: "ses_branch",
        directory: alpha,
        answer: `answer: ${"detail ".repeat(400)}`,
        updated: Date.now() - 30 * 60_000,
      }),
    ]);
    if (!made) return; // no sqlite builtin
    // Mid-session, the agent starts a branch for its change; after the session, the user moves on.
    gitAt(alpha, prompted + 3, "checkout", "-q", "-b", "feat/mid");
    gitAt(alpha, minutesAgo(10), "checkout", "-q", "-b", "feat/next");

    await dosu("sync");

    expect(posted().map((p) => p.metadata)).toEqual([
      expect.objectContaining({
        agent: "opencode",
        session_id: "ses_branch",
        branch: "feat/layout",
      }),
    ]);
  });

  it("an opencode session the prompt hook first serves partway through keeps the branch it began on", async () => {
    // The sync may ask opencode for its export; the prompt, which waits, must not.
    const bin = join(home, "bin");
    mkdirSync(bin);
    const exports = join(home, "opencode-calls.log");
    writeFileSync(exports, "");
    writeFileSync(join(bin, "opencode"), `#!/bin/sh\necho "$*" >> "${exports}"\nexit 1\n`, {
      mode: 0o755,
    });
    vi.stubEnv("PATH", `${bin}${delimiter}${process.env.PATH ?? ""}`);
    const prompted = Math.floor(opencodeDocument().messages[0].info.time.created / 1000);
    const alpha = checkoutOn("alpha", "feat/layout", prompted - 600);
    mkdirSync(join(home, ".local", "share", "opencode"), { recursive: true });
    const made = makeOpencodeDb(join(home, ".local", "share", "opencode", "opencode.db"), [
      opencodeDocument({
        id: "ses_resumed",
        directory: alpha,
        answer: `answer: ${"detail ".repeat(400)}`,
        updated: Date.now() - 30 * 60_000,
      }),
    ]);
    if (!made) return; // no sqlite builtin
    gitAt(alpha, minutesAgo(10), "checkout", "-q", "-b", "feat/next");
    const context = vi.fn<Fetch>(async () => new Response(JSON.stringify({ digest: null })));
    // The plugin went in after the session's first prompts; this one resumes it.
    await contextHookOutput(
      JSON.stringify({ prompt: "and the footer?", session_id: "ses_resumed", cwd: alpha }),
      {
        apiKey: "sk_test",
        deploymentId: "dep1",
        backendUrl: "https://api.dosu.test",
        agent: "opencode",
        format: "plain",
        fetchImpl: context,
      },
    );
    expect(readFileSync(exports, "utf-8")).toBe("");

    await dosu("sync");

    const [[, init]] = context.mock.calls;
    expect(JSON.parse(init?.body as string).branch).toBe("feat/layout");
    expect(posted().map((p) => p.metadata.branch)).toEqual(["feat/layout"]);
  });

  it("ships a Cursor session with the branch its first turn was on, not one a later turn moved to", async () => {
    const now = Math.floor(Date.now() / 1000);
    const alpha = checkoutOn("alpha", "feat/start", now - 3600);
    const dir = join(home, ".cursor", "projects", "work-alpha", "agent-transcripts", "c1");
    mkdirSync(dir, { recursive: true });
    const transcript = join(dir, "c1.jsonl");
    const rows = [
      { role: "user", message: { content: [{ type: "text", text: "lay out the footer" }] } },
      {
        role: "assistant",
        message: { content: [{ type: "text", text: `done: ${"detail ".repeat(400)}` }] },
      },
    ];
    writeFileSync(transcript, `${rows.map((r) => JSON.stringify(r)).join("\n")}\n`);
    // Cursor's `stop` hook, after each turn.
    const stop = async () => {
      hookStdin({
        hook_event_name: "stop",
        cursor_version: "2.0.0",
        conversation_id: "c1",
        transcript_path: transcript,
        workspace_roots: [alpha],
      });
      await dosu("sync", "--quiet", "--detach");
    };
    await stop();
    // The second turn starts a branch for its change; the session's last activity is after it.
    gitAt(alpha, now + 2, "checkout", "-q", "-b", "feat/mid");
    await stop();
    const last = new Date((now + 3) * 1000);
    utimesSync(transcript, last, last);

    await dosu("sync", "--flush");

    expect(posted().map((p) => [p.metadata.agent, p.metadata.branch])).toEqual([
      ["cursor", "feat/start"],
    ]);
  });

  it("ships a Claude Code session with the branch its transcript recorded, as before", async () => {
    const alpha = checkoutOn("alpha", "feat/now", minutesAgo(90));
    const recorded = exchange(1, alpha)
      .trimEnd()
      .split("\n")
      .map((line) => JSON.stringify({ ...JSON.parse(line), gitBranch: "feat/claude" }))
      .join("\n");
    claudeSession("aaaa", `${recorded}\n`, 30);

    await dosu("sync");

    const [shipped] = posted();
    expect(shipped.records[0]).toMatchObject({ role: "meta", git_branch: "feat/claude" });
    expect(shipped.metadata.branch).toBe("feat/claude");
  });

  it("ships a Codex session with the branch its session_meta recorded, as before", async () => {
    const alpha = checkoutOn("alpha", "feat/now", minutesAgo(90));
    codexRollout("rollout-2026-10-02T10-00-00-01a0ff2b-0000-7000-8000-000000000001", alpha, 30, {
      git: { branch: "feat/codex", commit_hash: "abc" },
    });

    await dosu("sync");

    const [shipped] = posted();
    expect(shipped.records[0]).toMatchObject({ role: "meta", git_branch: "feat/codex" });
    expect(shipped.metadata.branch).toBe("feat/codex");
  });

  it("ships a recorded branch verbatim, the one the session's prompts asked memory with", async () => {
    // A Jira-style name reads as high-entropy text to the redactor; a branch is not text.
    const branch = "feature/PROJ-4821-AddRetryLogicForPayments";
    const alpha = checkoutOn("alpha", branch, minutesAgo(90));
    const recorded = exchange(1, alpha)
      .trimEnd()
      .split("\n")
      .map((line) => JSON.stringify({ ...JSON.parse(line), gitBranch: branch }))
      .join("\n");
    const claude = claudeSession("aaaa", `${recorded}\n`, 30);
    const name = "rollout-2026-10-02T10-00-00-01a0ff2b-0000-7000-8000-000000000001";
    const codex = codexRollout(name, alpha, 30, { git: { branch, commit_hash: "abc" } });
    const context = vi.fn<Fetch>(async () => new Response(JSON.stringify({ digest: null })));
    const ask = (agent: string, format: "claude" | "codex", transcript: string) =>
      contextHookOutput(
        JSON.stringify({
          hook_event_name: "UserPromptSubmit",
          session_id: basename(transcript, ".jsonl"),
          transcript_path: transcript,
          cwd: alpha,
          prompt: "and the retries?",
        }),
        {
          apiKey: "sk_test",
          deploymentId: "dep1",
          backendUrl: "x",
          agent,
          format,
          fetchImpl: context,
        },
      );
    await ask("claude-code", "claude", claude);
    await ask("codex", "codex", codex);

    await dosu("sync");

    const asked = context.mock.calls.map(([, init]) => JSON.parse(init?.body as string).branch);
    expect(asked).toEqual([branch, branch]);
    const shipped = posted();
    expect(shipped.map((p) => p.metadata.branch)).toEqual([branch, branch]);
    for (const { records } of shipped) {
      expect(records[0]).toMatchObject({ role: "meta", git_branch: branch });
    }
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

describe("knowledge sync --flush (the last step before a machine is torn down)", () => {
  const shippedIds = () => posted().map((p) => p.metadata.session_id);

  it("ships every pending session now, the ones still inside the quiet period included", async () => {
    const alpha = gitRepo("alpha", "git@github.com:acme/alpha.git");
    claudeSession("older", exchange(1, alpha), 60);
    // Written a moment ago, and no end event will ever name it: its agent was killed.
    claudeSession("killed", exchange(2, alpha), 0);

    await dosu("sync", "--flush");

    expect(shippedIds()).toEqual(["older", "killed"]);
  });

  it("drains the whole backlog, past the per-run batch limit", async () => {
    const alpha = gitRepo("alpha", "git@github.com:acme/alpha.git");
    const total = SHIP_BATCH_LIMIT + 3;
    for (let i = 0; i < total; i++) claudeSession(`s${i}`, exchange(1, alpha), i % 2 ? 0 : 30);

    await dosu("sync", "--flush");

    expect(new Set(shippedIds()).size).toBe(total);
  });

  it("still keeps incognito, trivial, and out-of-scope sessions out", async () => {
    const alpha = gitRepo("alpha", "git@github.com:acme/alpha.git");
    const beta = gitRepo("beta", "git@github.com:acme/beta.git");
    saveSyncState({ ...emptySyncState(), repo_filter: ["github.com/acme/alpha"] });
    claudeSession("kept", exchange(1, alpha), 0);
    claudeSession(
      "incognito",
      exchange(2, alpha).replace("question 2", `${INCOGNITO_MARKER} question 2`),
      0,
    );
    claudeSession(
      "trivial",
      `${JSON.stringify({ type: "user", uuid: "u", cwd: alpha, message: { role: "user", content: "hi" } })}\n`,
      0,
    );
    claudeSession("elsewhere", exchange(3, beta), 0);

    await dosu("sync", "--flush");

    expect(shippedIds()).toEqual(["kept"]);
  });

  it("is an explicit command: it resumes paused syncing, even with --quiet", async () => {
    const alpha = gitRepo("alpha", "git@github.com:acme/alpha.git");
    claudeSession("aaaa", exchange(1, alpha), 0);
    saveSyncState({ ...emptySyncState(), paused: true });

    await dosu("sync", "--flush", "--quiet");

    expect(shippedIds()).toEqual(["aaaa"]);
    expect(loadSyncState().paused).toBeUndefined();
  });

  it("does not wait out a failure backoff, even with --quiet", async () => {
    const alpha = gitRepo("alpha", "git@github.com:acme/alpha.git");
    claudeSession("aaaa", exchange(1, alpha), 30);
    claudeSession("bbbb", exchange(2, alpha), 0);
    saveSyncState({
      ...emptySyncState(),
      consecutive_failures: 3,
      last_attempt_at: new Date().toISOString(),
    });

    await dosu("sync", "--flush", "--quiet");

    expect(shippedIds()).toEqual(["aaaa", "bbbb"]);
  });

  it("waits for a run holding the sync lock instead of skipping, as an ended session's run does", async () => {
    const alpha = gitRepo("alpha", "git@github.com:acme/alpha.git");
    claudeSession("aaaa", exchange(1, alpha), 0);
    // Another run (this live process stands in for it) holds the lock, and finishes shortly.
    const lock = lockPath();
    writeFileSync(lock, String(process.pid));
    const otherRun = setTimeout(() => rmSync(lock, { force: true }), 200);

    try {
      await dosu("sync", "--flush");
    } finally {
      clearTimeout(otherRun);
    }

    expect(shippedIds()).toEqual(["aaaa"]);
  });

  it("refuses --detach: a flush must be done before the machine goes away", async () => {
    const stderr = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    vi.spyOn(process, "exit").mockImplementation((code) => {
      throw new Error(`exit ${code}`);
    });

    await expect(dosu("sync", "--flush", "--detach")).rejects.toThrow("exit 1");

    expect(stderr.mock.calls.join("")).toMatch(/'--flush' cannot be used with option '--detach'/);
    expect(mockSpawn).not.toHaveBeenCalled();
    expect(fetchImpl).not.toHaveBeenCalled();
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
