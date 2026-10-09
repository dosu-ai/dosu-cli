/** The sync pipeline end to end: real session files under a temporary home, the real scanner,
 * ledger, and ship step, with only HTTP faked. */

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
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createProjectDirResolver } from "../sessions/project-dir";
import { scanAgentSessions } from "../sessions/scan";
import { createShipStep } from "../shipper/runner";
import { fileLock } from "./lock";
import { loadSyncState, saveSyncState } from "./state";
import { runKnowledgeSync, type SyncDeps } from "./sync";

const NOW = new Date("2026-10-02T12:00:00.000Z");
const minutesAgo = (m: number) => new Date(NOW.getTime() - m * 60_000);

let home: string;
let configDir: string;
type Fetch = (input: string, init?: RequestInit) => Promise<Response>;
let fetchImpl: ReturnType<typeof vi.fn<Fetch>>;

beforeEach(() => {
  home = realpathSync(mkdtempSync(join(tmpdir(), "dosu-pipeline-")));
  configDir = join(home, ".config", "dosu-cli");
  mkdirSync(configDir, { recursive: true });
  // The ship step's own project cache lives in the CLI's config dir.
  vi.stubEnv("XDG_CONFIG_HOME", join(home, ".config"));
  vi.stubEnv("DOSU_PROJECT", undefined);
  fetchImpl = vi.fn<Fetch>(
    async () =>
      new Response(JSON.stringify({ task_id: "task", session_url: null }), { status: 202 }),
  );
});

afterEach(() => {
  vi.unstubAllEnvs();
  rmSync(home, { recursive: true, force: true });
});

/** The pipeline's deps; `projects: "git"` resolves real project keys instead of a fixed one. */
function deps(projects: "fixed" | "git" = "fixed"): SyncDeps {
  return {
    listSessions: () =>
      scanAgentSessions({ homeDir: home, env: {}, since: minutesAgo(60 * 24 * 30) }),
    loadState: () => loadSyncState(configDir),
    saveState: (state) => saveSyncState(state, configDir),
    lock: fileLock(configDir),
    locator: createProjectDirResolver(configDir),
    ship: createShipStep({
      apiKey: "sk_test",
      deploymentId: "dep1",
      backendUrl: "https://api.dosu.test",
      fetchImpl,
      ...(projects === "fixed"
        ? { resolveProject: () => ({ project: "github.com/acme/app", rule: "origin" as const }) }
        : {}),
    }),
    now: () => NOW,
    cliVersion: "1.0.0",
  };
}

/** One user/assistant exchange as Claude Code logs it, big enough to be worth shipping. */
function exchange(n: number, cwd: string = home): string {
  const at = (s: number) => `2026-10-02T10:0${n}:${String(s).padStart(2, "0")}.000Z`;
  return `${[
    JSON.stringify({
      type: "user",
      uuid: `u${n}`,
      timestamp: at(0),
      cwd,
      sessionId: "sess",
      message: { role: "user", content: `question ${n}` },
    }),
    JSON.stringify({
      type: "assistant",
      uuid: `a${n}`,
      timestamp: at(30),
      sessionId: "sess",
      message: {
        role: "assistant",
        model: "claude-x",
        content: [{ type: "text", text: `answer ${n}: ${"detail ".repeat(400)}` }],
      },
    }),
  ].join("\n")}\n`;
}

function claudeSession(id: string, body: string, touched: Date): string {
  const dir = join(home, ".claude", "projects", "-work-app");
  mkdirSync(dir, { recursive: true });
  const path = join(dir, `${id}.jsonl`);
  writeFileSync(path, body);
  utimesSync(path, touched, touched);
  return path;
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

function posted(call: number): { records: { role: string }[]; metadata: Record<string, unknown> } {
  return JSON.parse(fetchImpl.mock.calls[call][1]?.body as string);
}

describe("knowledge sync, end to end", () => {
  it("a resumed session ships only its new tail, then nothing until it changes again", async () => {
    const path = claudeSession("sess", exchange(1), minutesAgo(30));

    expect((await runKnowledgeSync({ deps: deps() })).counts?.shipped).toBe(1);
    const first = posted(0);
    expect(first.metadata.continuation).toBeUndefined();

    appendFileSync(path, exchange(2));
    utimesSync(path, minutesAgo(10), minutesAgo(10));
    expect((await runKnowledgeSync({ deps: deps() })).counts?.shipped).toBe(1);

    const second = posted(1);
    expect(second.metadata.continuation).toEqual({
      from_record: first.records.length,
      prefix_sha256: expect.stringMatching(/^[0-9a-f]{64}$/),
    });
    // The meta record, then only the second exchange.
    expect(second.records.map((r) => r.role)).toEqual(["meta", "user", "assistant"]);
    expect(JSON.stringify(second.records)).not.toContain("question 1");

    expect((await runKnowledgeSync({ deps: deps() })).status).toBe("nothing-new");
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it("a session skipped as trivial is shipped once it grows into something", async () => {
    const tiny = `${JSON.stringify({
      type: "user",
      uuid: "u0",
      timestamp: "2026-10-02T09:00:00.000Z",
      cwd: home,
      sessionId: "late",
      message: { role: "user", content: "hi" },
    })}\n`;
    const path = claudeSession("late", tiny, minutesAgo(60));
    // A newer session ships first; under the old watermark the older one was gone for good.
    claudeSession("newer", exchange(1), minutesAgo(30));

    const first = await runKnowledgeSync({ deps: deps() });
    expect(first.counts).toMatchObject({ shipped: 1, trivial: 1 });

    appendFileSync(path, exchange(3));
    utimesSync(path, minutesAgo(20), minutesAgo(20));
    await runKnowledgeSync({ deps: deps() });

    expect(fetchImpl).toHaveBeenCalledTimes(2);
    expect(posted(1).metadata.session_id).toBe("late");
  });

  it("ships the session a SessionEnd hook just named, while a live one waits until quiet", async () => {
    const endedPath = claudeSession("ended", exchange(1), minutesAgo(0));
    claudeSession("live", exchange(2), minutesAgo(1));

    const outcome = await runKnowledgeSync({
      quiet: true,
      ended: [{ harness: "claude", id: "ended", path: endedPath }],
      deps: deps(),
    });

    expect(outcome).toMatchObject({ status: "shipped", inFlightSessions: 1 });
    expect(fetchImpl).toHaveBeenCalledOnce();
    expect(posted(0).metadata.session_id).toBe("ended");
  });

  it("a sync carrying DOSU_PROJECT ships every other session under its own project", async () => {
    const alpha = gitRepo("alpha", "git@github.com:acme/alpha.git");
    const beta = gitRepo("beta", "git@github.com:acme/beta.git");
    const endedPath = claudeSession("aaaa", exchange(1, alpha), minutesAgo(0));
    claudeSession("bbbb", exchange(2, beta), minutesAgo(60));
    // Alpha's agent ran with DOSU_PROJECT, and its prompt hook resolved the session in it.
    const promptHook = createProjectDirResolver(configDir, {
      env: { DOSU_PROJECT: "poc-alpha" },
    });
    promptHook.resolveProjectAt("claude/aaaa", alpha);
    promptHook.flush();

    // Alpha's session-end hook triggers the sync, which inherits alpha's environment.
    vi.stubEnv("DOSU_PROJECT", "poc-alpha");
    await runKnowledgeSync({
      quiet: true,
      ended: [{ harness: "claude", id: "aaaa", path: endedPath }],
      deps: deps("git"),
    });

    const projects = Object.fromEntries(
      fetchImpl.mock.calls.map((_, i) => [
        posted(i).metadata.session_id,
        posted(i).metadata.project,
      ]),
    );
    expect(projects).toEqual({ aaaa: "poc-alpha", bbbb: "github.com/acme/beta" });
  });

  it("an ended session outside the scanned roots ships after a failed try, then its tail", async () => {
    // A Claude Code relocated with CLAUDE_CONFIG_DIR in only its own environment.
    const dir = join(home, "altcfg", "projects", "-work-app");
    mkdirSync(dir, { recursive: true });
    const path = join(dir, "far.jsonl");
    writeFileSync(path, exchange(1));
    utimesSync(path, minutesAgo(0), minutesAgo(0));
    fetchImpl.mockResolvedValueOnce(new Response("unavailable", { status: 503 }));

    const hook = await runKnowledgeSync({
      quiet: true,
      ended: [{ harness: "claude", id: "far", path }],
      deps: deps(),
    });
    expect(hook.status).toBe("ship-failed");

    // Later, from a shell without the variable: the run still knows where the session lives.
    utimesSync(path, minutesAgo(10), minutesAgo(10));
    expect((await runKnowledgeSync({ deps: deps() })).counts?.shipped).toBe(1);
    expect(posted(1).metadata.session_id).toBe("far");

    appendFileSync(path, exchange(2));
    utimesSync(path, minutesAgo(8), minutesAgo(8));
    expect((await runKnowledgeSync({ deps: deps() })).counts?.shipped).toBe(1);
    expect(posted(2).metadata.continuation).toMatchObject({
      from_record: posted(1).records.length,
    });
  });
});
