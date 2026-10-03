/** OpenCode's Dosu plugin: what `hooks enable opencode` installs, and the installed plugin itself,
 * loaded the way opencode loads it and driven through its hooks. Only the `dosu` binary it runs
 * (a script recording what it was given) and opencode's own client are faked. */

import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { INCOGNITO_COMMAND_BODY } from "../incognito/agents";
import { endedSessionOf } from "../sessions/capture";
import { allHookAgents, getHookAgent } from "./agents";

let home: string;
let bin: string;
let calls: string;

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "dosu-opencode-hook-"));
  bin = join(home, "bin");
  calls = join(home, "dosu-calls.jsonl");
  mkdirSync(bin);
  vi.stubEnv("HOME", home);
  vi.stubEnv("XDG_CONFIG_HOME", join(home, ".config"));
  vi.stubEnv("XDG_DATA_HOME", join(home, ".local", "share"));
  vi.stubEnv("DOSU_DEV", undefined);
  vi.stubEnv("PATH", `${bin}:/usr/bin:/bin`);
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.useRealTimers();
  rmSync(home, { recursive: true, force: true });
});

function opencode() {
  const agent = getHookAgent("opencode");
  if (!agent) throw new Error("no opencode hook agent");
  return agent;
}

const configDir = () => join(home, ".config", "opencode");
const pluginPath = () => join(configDir(), "plugin", "dosu.js");
const commandPath = () => join(configDir(), "command", "dosu-incognito.md");

describe("the opencode hook agent", () => {
  it("is registered, and detects OpenCode from its config or data dir", () => {
    expect(allHookAgents().map((a) => a.id())).toContain("opencode");
    expect(opencode().name()).toBe("OpenCode");
    expect(opencode().isInstalled()).toBe(false);
    mkdirSync(join(home, ".local", "share", "opencode"), { recursive: true });
    expect(opencode().isInstalled()).toBe(true);
  });

  it("installs the plugin and /dosu-incognito, and removes exactly those", () => {
    mkdirSync(join(configDir(), "plugin"), { recursive: true });
    mkdirSync(join(configDir(), "command"), { recursive: true });
    writeFileSync(
      join(configDir(), "plugin", "mine.js"),
      "export const Mine = async () => ({});\n",
    );
    writeFileSync(join(configDir(), "command", "review.md"), "Review the diff.\n");
    expect(opencode().isEnabled()).toBe(false);

    opencode().enable();

    expect(opencode().configPath()).toBe(pluginPath());
    expect(opencode().isEnabled()).toBe(true);
    const source = readFileSync(pluginPath(), "utf8");
    // Plain JavaScript importing only node builtins: opencode loads it with nothing installed.
    expect([...source.matchAll(/^import .* from "([^"]+)";$/gm)].map((m) => m[1])).toEqual([
      "node:child_process",
    ]);
    expect(source).toContain("dosu knowledge sync --quiet --detach");
    expect(source).toContain("dosu knowledge context --agent opencode --format plain");
    expect(readFileSync(commandPath(), "utf8")).toContain("dosu:incognito:v1");

    opencode().enable(); // idempotent
    opencode().disable();

    expect(existsSync(pluginPath())).toBe(false);
    expect(existsSync(commandPath())).toBe(false);
    expect(opencode().isEnabled()).toBe(false);
    expect(existsSync(join(configDir(), "plugin", "mine.js"))).toBe(true);
    expect(existsSync(join(configDir(), "command", "review.md"))).toBe(true);
  });

  it("leaves a plugin file of the same name that is not Dosu's", () => {
    mkdirSync(join(configDir(), "plugin"), { recursive: true });
    writeFileSync(pluginPath(), "export const Other = async () => ({});\n");

    expect(opencode().isEnabled()).toBe(false);
    opencode().disable();

    expect(readFileSync(pluginPath(), "utf8")).toContain("Other");
  });

  it("pins this working copy in dev mode, as the other agents' hooks do", () => {
    vi.stubEnv("DOSU_DEV", "true");
    vi.stubEnv("DOSU_BACKEND_URL_OVERRIDE", "http://127.0.0.1:9");

    opencode().enable();

    const source = readFileSync(pluginPath(), "utf8");
    expect(source).toContain("DOSU_DEV=true");
    expect(source).toContain("DOSU_BACKEND_URL_OVERRIDE='http://127.0.0.1:9'");
    expect(source).not.toContain('"dosu knowledge sync');
  });
});

interface Call {
  args: string;
  stdin: Record<string, unknown>;
}

/** A `dosu` on PATH that records each call and prints `digest` for `knowledge context`. */
function fakeDosu(digest = ""): void {
  const out = join(home, "digest.txt");
  writeFileSync(out, digest);
  const script = join(bin, "dosu");
  writeFileSync(
    script,
    [
      "#!/bin/sh",
      'input=$(cat | tr -d "\\n")',
      `printf '{"args":"%s","stdin":%s}\\n' "$*" "$input" >> '${calls}'`,
      `case "$*" in "knowledge context"*) cat '${out}';; esac`,
    ].join("\n"),
  );
  chmodSync(script, 0o755);
}

function dosuCalls(): Call[] {
  if (!existsSync(calls)) return [];
  return readFileSync(calls, "utf8")
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line) as Call);
}

type Hooks = {
  event: (input: { event: { type: string; properties: Record<string, unknown> } }) => Promise<void>;
  "chat.message": (
    input: { sessionID: string },
    output: { message: { id: string }; parts: Record<string, unknown>[] },
  ) => Promise<void>;
  dispose: () => Promise<void>;
};

/** The installed plugin, imported fresh (module state included) and started as opencode starts
 * it, with a client whose sessions hold `history`. */
async function startPlugin(history: Record<string, string[]> = {}): Promise<Hooks> {
  opencode().enable();
  const fresh = join(home, `dosu-${Math.random().toString(36).slice(2)}.js`);
  writeFileSync(fresh, readFileSync(pluginPath(), "utf8"));
  const mod = (await import(pathToFileURL(fresh).href)) as Record<
    string,
    (input: unknown) => Promise<Hooks>
  >;
  const plugins = Object.values(mod);
  expect(plugins).toHaveLength(1); // opencode calls every export as a plugin
  const client = {
    session: {
      messages: async ({ path }: { path: { id: string } }) => ({
        data: (history[path.id] ?? []).map((text) => ({
          info: { role: "user" },
          parts: [{ type: "text", text }],
        })),
      }),
    },
  };
  return plugins[0]({ directory: "/repo/app", worktree: "/repo/app", client });
}

/** opencode's part ids: `prt_`, 12 hex digits of time, 14 random characters. */
function partId(ms: number): string {
  return `prt_${(BigInt(ms) * 4096n + 1n).toString(16).slice(-12)}AAAAAAAAAAAAAA`;
}

function userMessage(sessionID: string, text: string) {
  const messageID = `msg_${sessionID}`;
  return {
    message: { id: messageID, sessionID, role: "user" },
    parts: [{ id: partId(Date.now() - 1000), sessionID, messageID, type: "text", text }] as Record<
      string,
      unknown
    >[],
  };
}

const created = (id: string, parentID?: string) => ({
  event: {
    type: "session.created",
    properties: { info: { id, ...(parentID ? { parentID } : {}) } },
  },
});
const idle = (sessionID: string) => ({
  event: { type: "session.idle", properties: { sessionID } },
});

describe("the opencode plugin", () => {
  it("adds the memory digest to a prompt, flagged, after what the user typed", async () => {
    fakeDosu("Dosu memory: the deploy codeword is PELICAN-7\n");
    const hooks = await startPlugin();
    await hooks.event(created("ses_a"));
    const output = userMessage("ses_a", "how does deploy work?");

    await hooks["chat.message"]({ sessionID: "ses_a" }, output);

    expect(dosuCalls()).toEqual([
      {
        args: "knowledge context --agent opencode --format plain",
        stdin: { prompt: "how does deploy work?", session_id: "ses_a", cwd: "/repo/app" },
      },
    ]);
    const [typed, memory] = output.parts;
    expect(memory).toMatchObject({
      type: "text",
      text: "Dosu memory: the deploy codeword is PELICAN-7",
      synthetic: true,
      metadata: { dosu_memory: true },
      sessionID: "ses_a",
      messageID: "msg_ses_a",
    });
    // opencode orders a message's parts by id: the digest follows the prompt.
    expect(memory.id).toMatch(/^prt_[0-9a-f]{12}[0-9A-Za-z]{14}$/);
    expect(String(memory.id) > String(typed.id)).toBe(true);
  });

  it("adds nothing when Dosu has nothing to say or cannot be run", async () => {
    fakeDosu("");
    const hooks = await startPlugin();
    const output = userMessage("ses_a", "hello");
    await hooks["chat.message"]({ sessionID: "ses_a" }, output);
    expect(output.parts).toHaveLength(1);

    rmSync(join(bin, "dosu"));
    await hooks["chat.message"]({ sessionID: "ses_a" }, output);
    expect(output.parts).toHaveLength(1);
  });

  it("asks nothing for an incognito session, a resumed one that went incognito, or a subagent's", async () => {
    fakeDosu("Dosu memory: something");
    const hooks = await startPlugin({ ses_old: ["earlier", INCOGNITO_COMMAND_BODY] });
    await hooks.event(created("ses_a"));
    await hooks.event(created("ses_child", "ses_b"));

    const marked = userMessage("ses_a", INCOGNITO_COMMAND_BODY);
    await hooks["chat.message"]({ sessionID: "ses_a" }, marked);
    await hooks["chat.message"]({ sessionID: "ses_a" }, userMessage("ses_a", "now deploy"));
    // Resumed in this process: its history says it went incognito.
    await hooks["chat.message"]({ sessionID: "ses_old" }, userMessage("ses_old", "continue"));
    await hooks["chat.message"]({ sessionID: "ses_child" }, userMessage("ses_child", "read it"));

    expect(dosuCalls()).toEqual([]);
    expect(marked.parts).toHaveLength(1);
  });

  it("reports every session that ran here as ended when opencode shuts it down", async () => {
    fakeDosu();
    const hooks = await startPlugin();
    await hooks.event(created("ses_a"));
    await hooks.event(created("ses_child", "ses_a"));
    await hooks.event(created("ses_untouched"));
    await hooks["chat.message"]({ sessionID: "ses_child" }, userMessage("ses_child", "read it"));
    await hooks.event(idle("ses_child"));
    await hooks.event(idle("ses_a"));

    await hooks.dispose();

    const syncs = dosuCalls().filter((c) => c.args.startsWith("knowledge sync"));
    expect(syncs.map((c) => c.args)).toEqual([
      "knowledge sync --quiet --detach",
      "knowledge sync --quiet --detach",
    ]);
    // Each payload is an end event `knowledge sync --detach` turns into --ended.
    expect(syncs.map((c) => endedSessionOf(c.stdin))).toEqual([
      { harness: "opencode", id: "ses_child" },
      { harness: "opencode", id: "ses_a" },
    ]);

    await hooks.dispose(); // a second shutdown of the same instance reports nothing new
    expect(dosuCalls().filter((c) => c.args.startsWith("knowledge sync"))).toHaveLength(2);
  });

  it("runs a plain sync after a turn at most every five minutes, ending nothing", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-10-02T10:00:00Z"));
    fakeDosu();
    const hooks = await startPlugin();

    await hooks.event(idle("ses_a"));
    vi.setSystemTime(new Date("2026-10-02T10:06:00Z"));
    await hooks.event(idle("ses_a"));
    await hooks.event(idle("ses_b"));

    // The idle sync is not awaited; give the spawned script a moment to record itself.
    await vi.waitFor(() => expect(dosuCalls()).toHaveLength(1), { timeout: 5000 });
    const [sync] = dosuCalls();
    expect(sync.args).toBe("knowledge sync --quiet --detach");
    expect(endedSessionOf(sync.stdin)).toBeNull();
  });

  it("does nothing at shutdown in a process that ran no session, like `opencode export`", async () => {
    fakeDosu();
    const hooks = await startPlugin();

    await hooks.dispose();

    expect(dosuCalls()).toEqual([]);
  });
});
