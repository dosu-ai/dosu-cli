/** `dosu knowledge sync` as a hook runs it: a temporary home with real transcripts, git checkouts,
 * config, ledger, and project cache, and only the ingest API faked. */

import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { saveConfig } from "../config/config";
import { makeTestConfig } from "../config/config.test-utils";
import { knowledgeCommand } from "./knowledge";

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
    await dosu("sync", "--quiet", "--ended", "claude:aaaa", "--ended-path", ended);

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
    await dosu("sync", "--quiet", "--ended", "claude:aaaa", "--ended-path", ended);
    // Later, past the quiet period, a manual run from a shell without the variable.
    const later = new Date(Date.now() - 10 * 60_000);
    utimesSync(ended, later, later);
    vi.stubEnv("DOSU_PROJECT", undefined);
    await dosu("sync");

    expect(posted().map((p) => p.metadata.project)).toEqual(["poc-alpha", "poc-alpha"]);
  });
});
