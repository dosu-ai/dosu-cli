/** `dosu knowledge scope` and `dosu knowledge skip-backlog`: choosing what ships without the
 * interactive TUI or setup prompt, as a provisioning script does. A temporary home with real
 * transcripts, git checkouts, and ledger; only the ingest API is faked. */

import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { saveConfig } from "../config/config";
import { makeTestConfig } from "../config/config.test-utils";
import { emptySyncState, loadSyncState, saveSyncState, setShipTranscripts } from "../sync/state";
import { knowledgeCommand } from "./knowledge";

let home: string;
type Fetch = (input: string, init?: RequestInit) => Promise<Response>;
let fetchImpl: ReturnType<typeof vi.fn<Fetch>>;
let stdout: string[];

beforeEach(() => {
  home = realpathSync(mkdtempSync(join(tmpdir(), "dosu-knowledge-scope-")));
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
  stdout = [];
  vi.spyOn(console, "log").mockImplementation((...args: unknown[]) => {
    stdout.push(args.join(" "));
  });
  vi.spyOn(console, "error").mockImplementation((...args: unknown[]) => {
    stdout.push(args.join(" "));
  });
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  process.exitCode = undefined;
  rmSync(home, { recursive: true, force: true });
});

async function dosu(...args: string[]): Promise<void> {
  const cmd = knowledgeCommand();
  cmd.exitOverride();
  await cmd.parseAsync(["node", "dosu", ...args]);
}

const shippedIds = () =>
  fetchImpl.mock.calls.map(([, init]) => JSON.parse(init?.body as string).metadata.session_id);

/** A git checkout under the temporary home with one commit, and an origin when given one. */
function gitRepo(name: string, origin?: string): string {
  const dir = join(home, "work", name);
  mkdirSync(dir, { recursive: true });
  const git = (...args: string[]) =>
    execFileSync("git", ["-C", dir, "-c", "user.name=t", "-c", "user.email=t@t", ...args], {
      stdio: "ignore",
    });
  git("init", "-q");
  if (origin) git("remote", "add", "origin", origin);
  git("commit", "-q", "--allow-empty", "-m", "init");
  return dir;
}

/** One user/assistant exchange as Claude Code logs it, big enough to be worth shipping. */
function exchange(cwd: string): string {
  return `${[
    { type: "user", uuid: "u1", cwd, message: { role: "user", content: "question" } },
    {
      type: "assistant",
      uuid: "a1",
      message: {
        role: "assistant",
        model: "claude-x",
        content: [{ type: "text", text: `answer: ${"detail ".repeat(400)}` }],
      },
    },
  ]
    .map((r) => JSON.stringify({ ...r, sessionId: "s", timestamp: "2026-10-02T10:00:00.000Z" }))
    .join("\n")}\n`;
}

/** A Claude Code transcript under the temporary home, last written at `at`. */
function claudeSession(id: string, cwd: string, at: Date): string {
  const dir = join(home, ".claude", "projects", "-work");
  mkdirSync(dir, { recursive: true });
  const path = join(dir, `${id}.jsonl`);
  writeFileSync(path, exchange(cwd));
  utimesSync(path, at, at);
  return path;
}

const minutesAgo = (n: number) => new Date(Date.now() - n * 60_000);

describe("knowledge scope", () => {
  it("set limits shipping to the repos the named checkouts come from", async () => {
    const alpha = gitRepo("alpha", "git@github.com:Acme/Alpha.git");
    const beta = gitRepo("beta", "git@github.com:acme/beta.git");
    claudeSession("in-alpha", alpha, minutesAgo(30));
    claudeSession("in-beta", beta, minutesAgo(30));

    await dosu("scope", "set", alpha);
    await dosu("sync");

    expect(loadSyncState().repo_filter).toEqual(["github.com/acme/alpha"]);
    expect(shippedIds()).toEqual(["in-alpha"]);
  });

  it("set replaces the scope it finds, including a legacy folder scope", async () => {
    const alpha = gitRepo("alpha", "git@github.com:acme/alpha.git");
    const beta = gitRepo("beta", "https://github.com/acme/beta");
    saveSyncState({
      ...emptySyncState(),
      repo_filter: ["github.com/acme/old"],
      project_filter: ["/somewhere"],
    });

    await dosu("scope", "set", beta, alpha, join(alpha, "."));

    const state = loadSyncState();
    expect(state.repo_filter).toEqual(["github.com/acme/alpha", "github.com/acme/beta"]);
    expect(state.project_filter).toBeUndefined();
  });

  it("set refuses a directory with no origin remote and leaves the scope as it was", async () => {
    const alpha = gitRepo("alpha", "git@github.com:acme/alpha.git");
    const local = gitRepo("local");
    saveSyncState({ ...emptySyncState(), repo_filter: ["github.com/acme/old"] });

    await dosu("scope", "set", alpha, local);

    expect(process.exitCode).toBe(1);
    expect(stdout.join("\n")).toContain(`${local} has no git origin remote`);
    expect(loadSyncState().repo_filter).toEqual(["github.com/acme/old"]);
  });

  it("set refuses a path that is not a directory", async () => {
    await dosu("scope", "set", join(home, "missing"));

    expect(process.exitCode).toBe(1);
    expect(loadSyncState().repo_filter).toBeUndefined();
  });

  it("clear ships every repo again, and sessions outside any repo", async () => {
    const alpha = gitRepo("alpha", "git@github.com:acme/alpha.git");
    const outside = join(home, "scratch");
    mkdirSync(outside);
    claudeSession("in-alpha", alpha, minutesAgo(30));
    claudeSession("outside", outside, minutesAgo(20));
    saveSyncState({ ...emptySyncState(), repo_filter: ["github.com/acme/other"] });

    await dosu("scope", "clear");
    await dosu("sync");

    expect(loadSyncState().repo_filter).toBeUndefined();
    expect(shippedIds()).toEqual(["in-alpha", "outside"]);
  });

  it("show reports the scope, as JSON too", async () => {
    await dosu("scope", "show", "--json");
    saveSyncState({ ...emptySyncState(), repo_filter: ["github.com/acme/alpha"] });
    await dosu("scope", "show", "--json");
    await dosu("scope", "show");

    expect(JSON.parse(stdout[0])).toEqual({ repos: null });
    expect(JSON.parse(stdout[1])).toEqual({ repos: ["github.com/acme/alpha"] });
    expect(stdout.slice(2).join("\n")).toContain("github.com/acme/alpha");
  });

  it("keeps the rest of the state: the ledger, the pause switch, the shipping opt-out", async () => {
    const alpha = gitRepo("alpha", "git@github.com:acme/alpha.git");
    const entry = {
      updated: "2026-10-01T00:00:00.000Z",
      outcome: "shipped" as const,
      at: "2026-10-01T00:01:00.000Z",
      cli_version: "1.0.0",
      task_id: "t",
    };
    saveSyncState({ ...emptySyncState(), sessions: { "claude/x": entry }, paused: true });
    setShipTranscripts(false);

    await dosu("scope", "set", alpha);
    await dosu("scope", "clear");

    const state = loadSyncState();
    expect(state.sessions).toEqual({ "claude/x": entry });
    expect(state.paused).toBe(true);
    expect(state.ship_transcripts).toBe(false);
  });
});

describe("knowledge skip-backlog", () => {
  it("passes over the backlog, so only sessions that finish or change from now on ship", async () => {
    const alpha = gitRepo("alpha", "git@github.com:acme/alpha.git");
    claudeSession("finished", alpha, minutesAgo(60));
    const live = claudeSession("live", alpha, minutesAgo(1));

    await dosu("skip-backlog");
    // The live session carries on after the skip, then a new one finishes.
    utimesSync(live, minutesAgo(-1), minutesAgo(-1));
    claudeSession("new", alpha, minutesAgo(-2));
    await dosu("sync", "--flush");

    const { sessions } = loadSyncState();
    expect(sessions["claude/finished"]?.outcome).toBe("skipped_by_user");
    expect(shippedIds().sort()).toEqual(["live", "new"]);
  });

  it("--before passes over only sessions last active before then", async () => {
    const alpha = gitRepo("alpha", "git@github.com:acme/alpha.git");
    claudeSession("old", alpha, minutesAgo(20 * 24 * 60));
    claudeSession("recent", alpha, minutesAgo(60));
    const tenDaysAgo = minutesAgo(10 * 24 * 60)
      .toISOString()
      .slice(0, 10);

    await dosu("skip-backlog", "--before", tenDaysAgo);
    await dosu("sync");

    expect(loadSyncState().sessions["claude/old"]?.outcome).toBe("skipped_by_user");
    expect(shippedIds()).toEqual(["recent"]);
  });

  it("leaves sessions outside the repo scope alone, for a later, wider scope to decide", async () => {
    const alpha = gitRepo("alpha", "git@github.com:acme/alpha.git");
    const beta = gitRepo("beta", "git@github.com:acme/beta.git");
    claudeSession("in-alpha", alpha, minutesAgo(60));
    claudeSession("in-beta", beta, minutesAgo(60));
    saveSyncState({ ...emptySyncState(), repo_filter: ["github.com/acme/alpha"] });

    await dosu("skip-backlog");

    const { sessions } = loadSyncState();
    expect(sessions["claude/in-alpha"]?.outcome).toBe("skipped_by_user");
    expect(sessions["claude/in-beta"]).toBeUndefined();
  });

  it("works while shipping is switched off, and never ships anything itself", async () => {
    const alpha = gitRepo("alpha", "git@github.com:acme/alpha.git");
    claudeSession("finished", alpha, minutesAgo(60));
    setShipTranscripts(false);

    await dosu("skip-backlog", "--json");

    expect(fetchImpl).not.toHaveBeenCalled();
    expect(JSON.parse(stdout.join("\n"))).toMatchObject({ skipped: 1 });
    expect(loadSyncState().sessions["claude/finished"]?.outcome).toBe("skipped_by_user");
    expect(loadSyncState().ship_transcripts).toBe(false);
  });

  it("keeps a shipped session's ledger entry, so it still ships just its new tail", async () => {
    const alpha = gitRepo("alpha", "git@github.com:acme/alpha.git");
    claudeSession("shipped", alpha, minutesAgo(60));
    await dosu("sync");

    await dosu("skip-backlog");

    expect(loadSyncState().sessions["claude/shipped"]?.outcome).toBe("shipped");
  });

  it("refuses a date it cannot read", async () => {
    const alpha = gitRepo("alpha", "git@github.com:acme/alpha.git");
    claudeSession("finished", alpha, minutesAgo(60));

    await dosu("skip-backlog", "--before", "last tuesday");

    expect(process.exitCode).toBe(1);
    expect(loadSyncState().sessions["claude/finished"]).toBeUndefined();
  });
});
