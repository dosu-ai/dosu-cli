/** `dosu knowledge sync` as a hook runs it: a temporary home with real transcripts, git checkouts,
 * config, ledger, and project cache, and only the ingest API faked. */

import { execFileSync } from "node:child_process";
import {
  appendFileSync,
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { Readable } from "node:stream";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { saveConfig } from "../config/config";
import { makeTestConfig } from "../config/config.test-utils";
import { makeOpencodeDb, opencodeDocument } from "../sessions/opencode.test-utils";
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

  it("a per-turn hook payload names no session, so nothing skips the quiet period", async () => {
    hookStdin({ hook_event_name: "Stop", session_id: "aaaa", transcript_path: "/x/aaaa.jsonl" });

    await dosu("sync", "--quiet", "--detach");

    expect(respawnedArgs()).toEqual(["sync", "--quiet"]);
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
