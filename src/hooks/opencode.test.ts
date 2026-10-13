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
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { INCOGNITO_COMMAND_BODY } from "../incognito/agents";
import { setShipTranscripts } from "../sync/state";
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

  it("detects OpenCode installed but never run, from its binary on PATH", () => {
    writeFileSync(join(bin, "opencode"), "#!/bin/sh\n", { mode: 0o755 });
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
    setShipTranscripts(false);
    opencode().disable();

    expect(existsSync(pluginPath())).toBe(false);
    expect(existsSync(commandPath())).toBe(false);
    expect(opencode().isEnabled()).toBe(false);
    expect(existsSync(join(configDir(), "plugin", "mine.js"))).toBe(true);
    expect(existsSync(join(configDir(), "command", "review.md"))).toBe(true);
  });

  it("leaves no trace on a machine without OpenCode once disabled again", () => {
    opencode().enable();
    expect(opencode().isInstalled()).toBe(true);
    setShipTranscripts(false);

    opencode().disable();

    expect(existsSync(configDir())).toBe(false);
    expect(opencode().isInstalled()).toBe(false);
  });

  it("keeps /dosu-incognito when the plugin goes while transcript shipping is on", () => {
    opencode().enable();

    opencode().disable();

    // Any sync still ships OpenCode's sessions: another agent's hook, or a --flush.
    expect(existsSync(pluginPath())).toBe(false);
    expect(readFileSync(commandPath(), "utf8")).toContain("dosu:incognito:v1");
    expect(opencode().disableNote?.()).toBe(
      "Kept /dosu-incognito: OpenCode sessions still ship with any 'dosu knowledge sync' while transcript shipping is on. 'dosu knowledge incognito on opencode' keeps them all out.",
    );
  });

  it("keeps OpenCode's own config dir, whatever else it holds", () => {
    mkdirSync(configDir(), { recursive: true });
    writeFileSync(join(configDir(), "opencode.json"), "{}\n");
    setShipTranscripts(false);

    opencode().enable();
    opencode().disable();

    expect(readdirSync(configDir())).toEqual(["opencode.json"]);
  });

  it("never replaces or removes a plugin file of the same name that is not Dosu's", () => {
    mkdirSync(join(configDir(), "plugin"), { recursive: true });
    const theirs = "// my own plugin\nexport const Other = async () => ({});\n";
    writeFileSync(pluginPath(), theirs);

    expect(opencode().isEnabled()).toBe(false);
    expect(() => opencode().enable()).toThrow(`${pluginPath()} is not Dosu's plugin`);
    opencode().disable();

    expect(readFileSync(pluginPath(), "utf8")).toBe(theirs);
    expect(existsSync(commandPath())).toBe(false);
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
const [pluginPath, stepsJson, historyJson, configJson] = process.argv.slice(2);
const history = JSON.parse(historyJson);
const config = JSON.parse(configJson);

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
  config: { get: async () => ({ data: config }) },
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
  } else if (step === "tool") {
    const [sessionID, tool, toolArgs] = args;
    const output = { args: { ...toolArgs } };
    try {
      await hooks["tool.execute.before"]({ tool, sessionID, callID: "call_1" }, output);
      console.log(JSON.stringify({ tool, args: output.args }));
    } catch (err) {
      console.log(JSON.stringify({ tool, error: String(err?.message ?? err) }));
    }
  } else if (step === "shell") {
    const [sessionID] = args;
    const output = { env: {} };
    await hooks["shell.env"]({ cwd: "/w", ...(sessionID ? { sessionID, callID: "call_1" } : {}) }, output);
    console.log(JSON.stringify({ shell: sessionID ?? null, env: output.env }));
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
  | ["tool", string, string, Record<string, unknown>]
  | ["shell", string?]
  | ["idle", string]
  | ["dispose"]
  | ["advance", number]
  | ["kill"];

/** opencode's config with Dosu's MCP entry as `dosu mcp add` writes it: the local proxy. */
const PROXY_CONFIG = {
  mcp: { dosu: { type: "local", command: ["/bin/dosu", "mcp", "serve", "--client", "opencode"] } },
};

/** The installed plugin in an opencode process of its own: the parts of each prompt it ran, and
 * what each tool call looked like after it (or the error it stopped the call with). */
function opencodeProcess(
  steps: Step[],
  history: Record<string, string[]> = {},
  config: Record<string, unknown> = PROXY_CONFIG,
  // biome-ignore lint/suspicious/noExplicitAny: lines are either a prompt's parts or a tool call
): any[] {
  opencode().enable();
  const driver = join(home, "driver.mjs");
  writeFileSync(driver, DRIVER);
  const result = spawnSync(
    process.execPath,
    [driver, pluginPath(), JSON.stringify(steps), JSON.stringify(history), JSON.stringify(config)],
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

/** The process the test ran reported its sessions ended; nothing it started writes any more. */
const endReported = () => settle(() => expect(syncs()).toHaveLength(1));

const QUIET_SYNC_MS = 330_000;

describe("the opencode plugin", () => {
  it("adds the memory digest to a prompt, flagged, after what the user typed", async () => {
    fakeDosu("Dosu memory: the deploy codeword is PELICAN-7\n");

    const [parts] = opencodeProcess([
      ["start"],
      ["created", "ses_a"],
      ["chat", "ses_a", "how does deploy work?"],
    ]);
    await endReported();

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

  it("adds nothing when Dosu has nothing to say", async () => {
    fakeDosu("");
    const [parts] = opencodeProcess([["start"], ["chat", "ses_a", "hello"]]);
    await endReported();
    expect(parts).toHaveLength(1);
  });

  it("adds nothing when Dosu cannot be run", () => {
    const [parts] = opencodeProcess([["start"], ["chat", "ses_a", "hello"]]);
    expect(parts).toHaveLength(1);
  });

  it("asks nothing for an incognito session, a resumed one that went incognito, or a subagent's", async () => {
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
    await endReported();

    expect(dosuCalls().filter((c) => c.args.startsWith("knowledge context"))).toEqual([]);
    expect(marked).toHaveLength(1);
  });

  it("names the session in each call to Dosu's memory tools, for the proxy", async () => {
    fakeDosu("");
    const calls = opencodeProcess([
      ["start"],
      ["created", "ses_a"],
      ["chat", "ses_a", "deploy it"],
      ["tool", "ses_a", "dosu_search_memory", { query: "deploy" }],
      ["tool", "ses_a", "dosu_get_memory_evidence", { memory_id: "m1" }],
      ["tool", "ses_a", "bash", { command: "ls" }],
    ]).filter((line) => line.tool);
    await endReported();

    expect(calls).toEqual([
      { tool: "dosu_search_memory", args: { query: "deploy", _dosu_session: "ses_a" } },
      { tool: "dosu_get_memory_evidence", args: { memory_id: "m1", _dosu_session: "ses_a" } },
      { tool: "bash", args: { command: "ls" } },
    ]);
  });

  it("adds nothing to the arguments of a server that is not Dosu's proxy", async () => {
    fakeDosu("");
    const remote = { mcp: { dosu: { type: "remote", url: "https://api.dosu.dev/v2/mcp" } } };
    const calls = opencodeProcess(
      [["start"], ["tool", "ses_a", "dosu_search_memory", { query: "deploy" }]],
      {},
      remote,
    ).filter((line) => line.tool);

    expect(calls).toEqual([{ tool: "dosu_search_memory", args: { query: "deploy" } }]);
  });

  it("names the session to the shell commands it runs, for `dosu memory` run from them", async () => {
    fakeDosu("");
    const shells = opencodeProcess([
      ["start"],
      ["created", "ses_a"],
      ["shell", "ses_a"],
      // A terminal the user opens belongs to no session.
      ["shell"],
    ]).filter((line) => "shell" in line);

    expect(shells).toEqual([
      { shell: "ses_a", env: { DOSU_OPENCODE_SESSION: "ses_a" } },
      { shell: null, env: {} },
    ]);
  });

  it("stops the memory tools in an incognito session and its subagents' sessions", async () => {
    fakeDosu("");
    const calls = opencodeProcess(
      [
        ["start"],
        ["created", "ses_a"],
        ["chat", "ses_a", INCOGNITO_COMMAND_BODY],
        ["created", "ses_child", "ses_a"],
        ["tool", "ses_a", "dosu_search_memory", { query: "deploy" }],
        ["tool", "ses_child", "dosu_get_memory_evidence", { memory_id: "m1" }],
        ["chat", "ses_old", "continue"],
        ["tool", "ses_old", "dosu_search_memory", { query: "deploy" }],
        ["tool", "ses_a", "bash", { command: "ls" }],
        // Another server's tool of the same name is not Dosu's to stop.
        ["tool", "ses_a", "mem0_search_memory", { query: "deploy" }],
      ],
      { ses_old: ["earlier", INCOGNITO_COMMAND_BODY] },
    ).filter((line) => line.tool);
    await endReported();

    expect(calls.map((c) => [c.tool, c.error ? "stopped" : "ran"])).toEqual([
      ["dosu_search_memory", "stopped"],
      ["dosu_get_memory_evidence", "stopped"],
      ["dosu_search_memory", "stopped"],
      ["bash", "ran"],
      ["mem0_search_memory", "ran"],
    ]);
    expect(calls[0].error).toContain("Dosu is off for this session");
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
