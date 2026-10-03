/** OpenCode's Dosu plugin: what `hooks enable opencode` installs, and the installed plugin itself,
 * loaded the way opencode loads it, in a process of its own, driven through its hooks, then left
 * to exit. Only the `dosu` binary it runs (a script recording what it was given), opencode's own
 * client, and its clock are faked. */

import { spawnSync } from "node:child_process";
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
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { INCOGNITO_COMMAND_BODY } from "../incognito/agents";
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
  stdin: Record<string, unknown> | null;
  /** How far opencode's clock had moved when the plugin started this command (ms). */
  clock: number;
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
      `printf '{"args":"%s","stdin":%s,"clock":%s}\\n' "$*" "\${input:-null}" "\${DOSU_TEST_CLOCK:-null}" >> '${calls}'`,
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

const syncs = () => dosuCalls().filter((c) => c.args.startsWith("knowledge sync"));

/** Runs the plugin as opencode does: imports the module once and calls its one export per
 * instance (`start`, again after a reload), with a client whose sessions hold `history`. Steps
 * drive its hooks and opencode's clock; then the process exits, unless a step kills it. Prints the
 * parts each prompt carries after the plugin saw it, one JSON line per prompt. */
const DRIVER = `
import { pathToFileURL } from "node:url";
const [pluginPath, stepsJson, historyJson] = process.argv.slice(2);
const history = JSON.parse(historyJson);

const start = Date.now();
let now = start;
const timers = [];
Date.now = () => now;
globalThis.setTimeout = (fn, ms) => {
  const timer = { at: now + ms, fn, unref: () => timer };
  timers.push(timer);
  return timer;
};
globalThis.clearTimeout = (timer) => {
  if (timers.includes(timer)) timers.splice(timers.indexOf(timer), 1);
};
const tick = () => { process.env.DOSU_TEST_CLOCK = String(now - start); };
tick();
function advance(ms) {
  const until = now + ms;
  for (;;) {
    timers.sort((a, b) => a.at - b.at);
    if (!timers[0] || timers[0].at > until) break;
    const timer = timers.shift();
    now = timer.at;
    tick();
    timer.fn();
  }
  now = until;
  tick();
}

const plugins = Object.values(await import(pathToFileURL(pluginPath).href));
if (plugins.length !== 1) throw new Error("opencode calls every export as a plugin");
const client = {
  session: {
    messages: async ({ path }) => ({
      data: (history[path.id] ?? []).map((text) => ({ info: { role: "user" }, parts: [{ type: "text", text }] })),
    }),
  },
};
// opencode's part ids: prt_, 12 hex digits of time, 14 random characters.
const typedPartId = "prt_" + (BigInt(start - 1000) * 4096n + 1n).toString(16).slice(-12) + "AAAAAAAAAAAAAA";
let hooks;
for (const [step, ...args] of JSON.parse(stepsJson)) {
  if (step === "start") {
    hooks = await plugins[0]({ directory: "/repo/app", worktree: "/repo/app", client });
  } else if (step === "created") {
    const info = { id: args[0], ...(args[1] ? { parentID: args[1] } : {}) };
    await hooks.event({ event: { type: "session.created", properties: { info } } });
  } else if (step === "chat") {
    const [sessionID, text] = args;
    const messageID = "msg_" + sessionID;
    const output = {
      message: { id: messageID, sessionID, role: "user" },
      parts: [{ id: typedPartId, sessionID, messageID, type: "text", text }],
    };
    await hooks["chat.message"]({ sessionID }, output);
    console.log(JSON.stringify(output.parts));
  } else if (step === "idle") {
    await hooks.event({ event: { type: "session.idle", properties: { sessionID: args[0] } } });
  } else if (step === "dispose") {
    await hooks.dispose?.();
  } else if (step === "advance") {
    advance(args[0]);
  } else if (step === "kill") {
    process.kill(process.pid, "SIGKILL");
  }
}
process.exit(0);
`;

type Step =
  | ["start"]
  | ["created", string, string?]
  | ["chat", string, string]
  | ["idle", string]
  | ["dispose"]
  | ["advance", number]
  | ["kill"];

/** The installed plugin in an opencode process of its own: the parts of each prompt it ran. */
function opencodeProcess(
  steps: Step[],
  history: Record<string, string[]> = {},
): Record<string, unknown>[][] {
  opencode().enable();
  const driver = join(home, "driver.mjs");
  writeFileSync(driver, DRIVER);
  const result = spawnSync(
    process.execPath,
    [driver, pluginPath(), JSON.stringify(steps), JSON.stringify(history)],
    { encoding: "utf8" },
  );
  if (!steps.some(([step]) => step === "kill")) expect(result.status, result.stderr).toBe(0);
  return result.stdout
    .trim()
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line));
}

/** Detached commands record themselves a moment after they start. */
const settle = (check: () => void) => vi.waitFor(check, { timeout: 5000, interval: 50 });

const QUIET_SYNC_MS = 330_000;

describe("the opencode plugin", () => {
  it("adds the memory digest to a prompt, flagged, after what the user typed", () => {
    fakeDosu("Dosu memory: the deploy codeword is PELICAN-7\n");

    const [parts] = opencodeProcess([
      ["start"],
      ["created", "ses_a"],
      ["chat", "ses_a", "how does deploy work?"],
    ]);

    expect(dosuCalls().filter((c) => c.args.startsWith("knowledge context"))).toEqual([
      {
        args: "knowledge context --agent opencode --format plain",
        stdin: { prompt: "how does deploy work?", session_id: "ses_a", cwd: "/repo/app" },
        clock: 0,
      },
    ]);
    const [typed, memory] = parts;
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

  it("adds nothing when Dosu has nothing to say", () => {
    fakeDosu("");
    const [parts] = opencodeProcess([["start"], ["chat", "ses_a", "hello"]]);
    expect(parts).toHaveLength(1);
  });

  it("adds nothing when Dosu cannot be run", () => {
    const [parts] = opencodeProcess([["start"], ["chat", "ses_a", "hello"]]);
    expect(parts).toHaveLength(1);
  });

  it("asks nothing for an incognito session, a resumed one that went incognito, or a subagent's", () => {
    fakeDosu("Dosu memory: something");

    const [marked] = opencodeProcess(
      [
        ["start"],
        ["created", "ses_a"],
        ["created", "ses_child", "ses_b"],
        ["chat", "ses_a", INCOGNITO_COMMAND_BODY],
        ["chat", "ses_a", "now deploy"],
        // Resumed in this process: its history says it went incognito.
        ["chat", "ses_old", "continue"],
        ["chat", "ses_child", "read it"],
      ],
      { ses_old: ["earlier", INCOGNITO_COMMAND_BODY] },
    );

    expect(dosuCalls().filter((c) => c.args.startsWith("knowledge context"))).toEqual([]);
    expect(marked).toHaveLength(1);
  });

  it("reports every session that ran a turn as ended, in one sync, once opencode exits", async () => {
    fakeDosu();

    opencodeProcess([
      ["start"],
      ["created", "ses_a"],
      ["created", "ses_child", "ses_a"],
      ["created", "ses_untouched"],
      ["chat", "ses_a", "spawn a reader"],
      ["chat", "ses_child", "read it"],
      ["idle", "ses_child"],
      ["idle", "ses_a"],
    ]);

    await settle(() => expect(syncs()).toHaveLength(1));
    expect(syncs()[0].args).toBe(
      "knowledge sync --quiet --detach --ended opencode:ses_a --ended opencode:ses_child",
    );
  });

  it("reports them when opencode is killed outright, too", async () => {
    fakeDosu();

    opencodeProcess([["start"], ["chat", "ses_a", "deploy it"], ["kill"]]);

    await settle(() => expect(syncs()).toHaveLength(1));
    expect(syncs()[0].args).toBe("knowledge sync --quiet --detach --ended opencode:ses_a");
  });

  it("ends nothing when opencode reloads an instance, only when the process exits", async () => {
    fakeDosu();

    opencodeProcess([
      ["start"],
      ["chat", "ses_a", "first"],
      ["idle", "ses_a"],
      // `/connect`, a config change: the instance is disposed and started again, mid-session.
      ["dispose"],
      ["start"],
      ["chat", "ses_a", "second"],
      ["idle", "ses_a"],
    ]);

    await settle(() => expect(syncs()).toHaveLength(1));
    expect(syncs()[0].args).toBe("knowledge sync --quiet --detach --ended opencode:ses_a");
  });

  it("runs a plain sync once the last turn to go idle is past the quiet period", async () => {
    fakeDosu();

    opencodeProcess([
      ["start"],
      ["chat", "ses_a", "first"],
      ["idle", "ses_a"],
      ["advance", 60_000],
      ["chat", "ses_a", "second"],
      ["idle", "ses_a"],
      // The first idle's sync comes due with the second turn still quiet for less than the
      // period, so one more follows for it; then nothing, however long the TUI stays open.
      ["advance", 3_600_000],
    ]);

    await settle(() => expect(syncs()).toHaveLength(3));
    const plain = syncs()
      .filter((c) => !c.args.includes("--ended"))
      .sort((a, b) => a.clock - b.clock);
    expect(plain.map((c) => [c.args, c.clock])).toEqual([
      ["knowledge sync --quiet --detach", QUIET_SYNC_MS],
      ["knowledge sync --quiet --detach", 60_000 + QUIET_SYNC_MS],
    ]);
  });

  it("does nothing in a process that ran no session, like `opencode export`", async () => {
    fakeDosu();

    opencodeProcess([["start"], ["dispose"]]);

    await new Promise((resolve) => setTimeout(resolve, 300));
    expect(dosuCalls()).toEqual([]);
  });
});
