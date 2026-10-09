/** The Dosu pi extension as pi runs it: `hooks enable pi` writes the file, the test loads that very
 * file and drives it through a stand-in for pi's extension API, and the `dosu` it shells out to is
 * a fake executable on PATH that records each call. */

import { spawnSync } from "node:child_process";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  restoreRunningInstall,
  stubRunningInstall,
  testRuntime,
} from "../mcp/running-install.test-utils";
import { endedSessionOf } from "../sessions/capture";
import type { AgentSession } from "../sessions/scan";
import { isIncognitoSession } from "../sync/incognito";
import { setShipTranscripts } from "../sync/state";

let fakeHome: string;

vi.mock("node:os", async (importOriginal) => {
  const original = await importOriginal<typeof import("node:os")>();
  return { ...original, homedir: () => fakeHome };
});

import { knowledgeCommand } from "../commands/knowledge";
import { getHookAgent } from "./agents";
import { HookConfigError } from "./formats";

/** A `dosu` that logs argv, cwd and stdin, and answers per `<command> <subcommand>`; a reply
 * with `waitFor` answers only once that file exists, standing in for a slow start or server. */
const FAKE_DOSU = `#!/usr/bin/env node
const fs = require("node:fs");
let input = "";
process.stdin.on("data", (d) => (input += d));
process.stdin.on("end", () => {
  const argv = process.argv.slice(2);
  fs.appendFileSync(process.env.FAKE_DOSU_LOG, JSON.stringify({ argv, cwd: process.cwd(), input }) + "\\n");
  const reply = JSON.parse(process.env.FAKE_DOSU_REPLIES || "{}")[argv.slice(0, 2).join(" ")] || {};
  const answer = () => {
    if (reply.waitFor && !fs.existsSync(reply.waitFor)) return setTimeout(answer, 10);
    if (reply.stdout) process.stdout.write(reply.stdout);
    if (reply.stderr) process.stderr.write(reply.stderr);
    process.exit(reply.code || 0);
  };
  answer();
});
`;

let bin: string;
let log: string;
let cwd: string;

beforeEach(() => {
  fakeHome = realpathSync(mkdtempSync(join(tmpdir(), "dosu-pi-ext-")));
  bin = join(fakeHome, "bin");
  mkdirSync(bin);
  writeFileSync(join(bin, "dosu"), FAKE_DOSU);
  chmodSync(join(bin, "dosu"), 0o755);
  log = join(fakeHome, "dosu-calls.jsonl");
  cwd = join(fakeHome, "work");
  mkdirSync(cwd);
  vi.stubEnv("PATH", `${bin}:${process.env.PATH}`);
  vi.stubEnv("FAKE_DOSU_LOG", log);
  vi.stubEnv("FAKE_DOSU_REPLIES", "{}");
  vi.stubEnv("PI_CODING_AGENT_DIR", undefined);
  vi.stubEnv("DOSU_DEV", undefined);
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  restoreRunningInstall();
  rmSync(fakeHome, { recursive: true, force: true });
});

function replies(
  map: Record<string, { stdout?: string; stderr?: string; code?: number; waitFor?: string }>,
): void {
  vi.stubEnv("FAKE_DOSU_REPLIES", JSON.stringify(map));
}

interface DosuCall {
  argv: string[];
  cwd: string;
  input: string;
}

function calls(): DosuCall[] {
  if (!existsSync(log)) return [];
  return readFileSync(log, "utf-8")
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line));
}

/** The calls once `count` have come in: quitting pi stops waiting for its hand-off after
 * HANDOFF_TIMEOUT_MS, which a CLI started on a loaded machine can take longer than to log. */
async function handedOff(count: number): Promise<DosuCall[]> {
  await vi.waitFor(() => expect(calls()).toHaveLength(count), { timeout: 20_000 });
  return calls();
}

// biome-ignore lint/suspicious/noExplicitAny: pi's extension API, faked loosely
type Any = any;

const userTurn = (text: string) => ({
  type: "message",
  message: { role: "user", content: [{ type: "text", text }] },
});

/** What the model reads of a session entry: user turns, and extension messages (pi hands those to
 * the model as user-role context). */
function modelText(entry: Any): string[] {
  if (entry.type === "custom_message") return [entry.content];
  if (entry.type === "message" && entry.message.role === "user") {
    return [entry.message.content[0].text];
  }
  return [];
}

/** A stand-in for pi: the slice of its ExtensionAPI the extension uses, plus the behavior of pi's
 * own that the extension depends on. One agent run at a time, and a prompt that finds another run
 * starting or under way fails; `/name` runs an extension command instead; `sendUserMessage`
 * starts a prompt without waiting for it; `appendEntry` and `sendMessage` add session entries
 * (while a run is under way, a message is steered into it); with a UI, `ctx.ui` shows notices
 * and fills the editor. `print` drives it the way `pi -p <message>...` does: each message in
 * turn, failing on the first error. */
function fakePi(options: { hasUI?: boolean; mcp?: boolean } = {}) {
  const handlers = new Map<string, (event: Any, ctx: Any) => Any>();
  const tools = new Map<string, Any>();
  const commands = new Map<string, Any>();
  const mcpServers = new Map<string, Any>();
  const entries: Any[] = [];
  const steered: Any[] = [];
  const failures: string[] = [];
  const modelReads: string[][] = [];
  // The tools declared to the model in each run's request.
  const toolReads: string[][] = [];
  // Registered servers still connecting: pi connects them in the background.
  const connecting = new Map<string, Any>();
  const registeredMcpTools: string[] = [];
  const notices: { message: string; type?: string }[] = [];
  let active: string[] = ["read", "bash"];
  let running = false;
  let editorText = "";
  const ui = {
    notify: (message: string, type?: string) => notices.push({ message, type }),
    setEditorText: (text: string) => {
      editorText = text;
    },
  };
  const ctx = (transcript?: string) => ({
    ...piContext(entries, transcript),
    isIdle: () => !running,
    hasUI: !!options.hasUI,
    ui,
  });
  const tick = () => new Promise((resolve) => setTimeout(resolve, 0));

  async function prompt(text: string): Promise<void> {
    const command = /^\/(\S+)\s*([\s\S]*)$/.exec(text);
    if (command && commands.has(command[1])) {
      await commands.get(command[1]).handler(command[2], ctx());
      return;
    }
    // Input handlers and the auth check run before the agent run starts.
    await tick();
    if (running) {
      throw new Error(
        "Agent is already processing a prompt. Use steer() or followUp() to queue messages, or wait for completion.",
      );
    }
    running = true;
    try {
      const result = await handlers.get("before_agent_start")?.({ prompt: text }, ctx());
      // pi's built-in MCP, whose handler runs after other extensions', holds the first run until
      // servers with direct tools connect; the request lists the tools declared then.
      connect();
      entries.push(userTurn(text));
      if (result?.message) entries.push({ type: "custom_message", ...result.message });
      modelReads.push(entries.flatMap(modelText));
      toolReads.push([...active]);
      await tick();
      entries.push({ type: "message", message: { role: "assistant", content: [] } });
    } finally {
      running = false;
    }
  }

  function connect(): void {
    for (const [name, config] of connecting) {
      const names = DOSU_MCP_TOOLS.map((tool) => `mcp__${name}__${tool}`);
      registeredMcpTools.push(...names);
      if (config.exposure === "direct")
        active = [...active.filter((n) => !names.includes(n)), ...names];
    }
    connecting.clear();
  }

  const api = {
    on: (event: string, handler: (event: Any, ctx: Any) => Any) => {
      handlers.set(event, handler);
      return () => {};
    },
    registerTool: (tool: Any) => {
      tools.set(tool.name, tool);
      active.push(tool.name);
    },
    registerCommand: (name: string, options: Any) => commands.set(name, options),
    // pi's built-in MCP: a server registered again replaces the earlier registration; its direct
    // tools, named mcp__<server>__<tool>, are declared once it connects, in the background (here,
    // shortly after, or at the next run, or on connect()).
    registerMcpServer: (name: string, config: Any) => {
      mcpServers.set(name, config);
      connecting.set(name, config);
      setTimeout(connect, 20);
    },
    // Seen with pi 1.0.0: a print run that unregistered a server never exits.
    unregisterMcpServer: (name: string) => {
      mcpServers.delete(name);
      active = active.filter((n) => !n.startsWith(`mcp__${name}__`));
      failures.push(`pi hangs at exit: MCP server ${name} was unregistered`);
    },
    getActiveTools: () => [...active],
    getAllTools: () => [...new Set([...active, ...registeredMcpTools])].map((name) => ({ name })),
    setActiveTools: (names: string[]) => {
      active = names;
    },
    sendUserMessage: (content: string) => {
      prompt(content).catch((err: Error) => failures.push(err.message));
    },
    sendMessage: (message: Any) => {
      if (running) steered.push(message);
      else entries.push({ type: "custom_message", ...message });
    },
    appendEntry: (customType: string, data?: unknown) => {
      entries.push({ type: "custom", customType, data });
    },
  };
  // pi before 1.0 has no built-in MCP.
  if (options.mcp === false) {
    delete (api as Any).registerMcpServer;
    delete (api as Any).unregisterMcpServer;
  }
  return {
    api,
    handlers,
    tools,
    commands,
    mcpServers,
    /** A tool call as pi makes one, the model's or a codemode script's: once pi has validated
     * the arguments, extensions' tool_call handlers may block the call or change its arguments,
     * and the tool runs with what they leave. */
    callTool: async (toolName: string, input: Any = {}, context: Any = ctx()) => {
      const args = { ...input };
      const result = await handlers.get("tool_call")?.(
        { type: "tool_call", toolCallId: "call-1", toolName, input: args },
        context,
      );
      return result?.block ? { blocked: result.reason } : { ran: toolName, args };
    },
    entries,
    steered,
    failures,
    modelReads,
    toolReads,
    notices,
    /** The servers still connecting finish connecting. */
    connect,
    editorText: () => editorText,
    active: () => active,
    print: async (...messages: string[]) => {
      for (const message of messages) await prompt(message);
    },
    /** A run under way, for commands typed mid-run. */
    startRun: () => {
      running = true;
    },
    context: ctx,
  };
}

/** The tools Dosu's MCP server lists. */
const DOSU_MCP_TOOLS = ["search_memory", "get_memory_evidence"];
const DOSU_MCP_NAMES = DOSU_MCP_TOOLS.map((tool) => `mcp__dosu__${tool}`);

const TRANSCRIPT_NAME = "2026-10-02T17-59-42-611Z_01a0fdc5-a112.jsonl";

/** pi's context for a session in `cwd`; `parentSession` is the transcript a fork copied. */
function piContext(
  entries: unknown[] = [],
  transcript: string | undefined = undefined,
  parentSession: string | undefined = undefined,
) {
  return {
    cwd,
    isIdle: () => true,
    sessionManager: {
      getSessionId: () => "01a0fdc5-a112",
      getSessionFile: () => transcript,
      getEntries: () => entries,
      getHeader: () => ({ type: "session", id: "01a0fdc5-a112", cwd, parentSession }),
    },
  };
}

/** `ctx` for another session in the same pi, after /new, /resume or /fork. */
function withSessionId(ctx: ReturnType<typeof piContext>, id: string) {
  return { ...ctx, sessionManager: { ...ctx.sessionManager, getSessionId: () => id } };
}

/** What pi does with a registered stdio server: start it in its directory, its env over pi's. */
function serve(server: { command: string; args?: string[]; env?: object; cwd?: string }) {
  spawnSync(server.command, server.args ?? [], {
    cwd: server.cwd,
    env: { ...process.env, ...server.env },
    input: "",
    timeout: 20_000,
  });
}

/** Enable pi the way `dosu knowledge hooks enable pi` does, then load the file pi would load. */
async function loadExtension(options: { hasUI?: boolean; mcp?: boolean } = {}) {
  const agent = getHookAgent("pi");
  agent?.enable();
  const path = agent?.configPath() as string;
  const { default: extension } = await import(`${pathToFileURL(path).href}?t=${Date.now()}`);
  const pi = fakePi(options);
  extension(pi.api);
  return pi;
}

/** The transcript pi saves for `entries`, as the sync later reads it: pi writes a session's file
 * once it has a user or assistant message, and none before. */
function savedSession(entries: unknown[], name = "01a0fdc5-a112"): AgentSession | null {
  const conversation = entries.some(
    (e) => (e as Any).type === "message" && ["user", "assistant"].includes((e as Any).message.role),
  );
  if (!conversation) return null;
  const path = join(fakeHome, `${name}.jsonl`);
  const header = { type: "session", version: 3, id: name, cwd };
  writeFileSync(path, `${[header, ...entries].map((e) => JSON.stringify(e)).join("\n")}\n`);
  return { id: name, harness: "pi", path, updated: new Date().toISOString() };
}

describe("pi hook agent", () => {
  it("installs the extension in pi's extensions folder, and removes it", () => {
    vi.stubEnv("PATH", bin);
    const pi = getHookAgent("pi");
    expect(pi?.name()).toBe("Pi");
    expect(pi?.isInstalled()).toBe(false);
    mkdirSync(join(fakeHome, ".pi", "agent"), { recursive: true });
    expect(pi?.isInstalled()).toBe(true);
    expect(pi?.configPath()).toBe(join(fakeHome, ".pi", "agent", "extensions", "dosu.ts"));
    expect(pi?.isEnabled()).toBe(false);

    pi?.enable();
    expect(pi?.isEnabled()).toBe(true);
    expect(pi?.enableNote?.()).toContain("--no-extensions");
    pi?.enable();
    expect(pi?.isEnabled()).toBe(true);

    pi?.disable();
    expect(pi?.isEnabled()).toBe(false);
    expect(existsSync(pi?.configPath() as string)).toBe(false);
    pi?.disable();
  });

  it("says, once disabled, that pi's sessions still ship and /dosu-incognito went with it", () => {
    vi.stubEnv("XDG_CONFIG_HOME", join(fakeHome, ".config"));
    const pi = getHookAgent("pi");
    pi?.enable();
    pi?.disable();
    // The command is the extension's own: there is no file of it to keep.
    expect(pi?.disableNote?.()).toBe(
      "Pi sessions still ship with any 'dosu knowledge sync' while transcript shipping is on, and /dosu-incognito went with the extension. 'dosu knowledge incognito on pi' keeps them all out.",
    );

    setShipTranscripts(false);
    expect(pi?.disableNote?.()).toBe("");
  });

  it("counts pi as installed before its first run, when pi is on PATH", async () => {
    // pi creates ~/.pi/agent on its first run; a fresh VM sets Dosu up before that run.
    vi.stubEnv("PATH", bin);
    const pi = getHookAgent("pi");
    expect(pi?.isInstalled()).toBe(false);
    writeFileSync(join(bin, "pi"), "#!/bin/sh\n");
    chmodSync(join(bin, "pi"), 0o755);
    expect(pi?.isInstalled()).toBe(true);
    expect(existsSync(join(fakeHome, ".pi"))).toBe(false);

    // `hooks enable` with no agent named installs it for every detected agent, pi included.
    vi.spyOn(console, "log").mockImplementation(() => {});
    const cmd = knowledgeCommand();
    cmd.exitOverride();
    await cmd.parseAsync(["node", "dosu", "hooks", "enable"]);
    expect(pi?.isEnabled()).toBe(true);
  });

  it("honors PI_CODING_AGENT_DIR", () => {
    vi.stubEnv("PI_CODING_AGENT_DIR", "~/relocated-pi");
    const pi = getHookAgent("pi");
    pi?.enable();
    expect(existsSync(join(fakeHome, "relocated-pi", "extensions", "dosu.ts"))).toBe(true);
  });

  it("never replaces or removes a dosu.ts that is not Dosu's", () => {
    const pi = getHookAgent("pi");
    const path = pi?.configPath() as string;
    mkdirSync(join(path, ".."), { recursive: true });
    writeFileSync(path, "export default function mine() {}\n");

    expect(() => pi?.enable()).toThrow(HookConfigError);
    expect(pi?.isEnabled()).toBe(false);
    pi?.disable();
    expect(readFileSync(path, "utf-8")).toBe("export default function mine() {}\n");
  });

  it("pins this working copy and its endpoints in dev mode", () => {
    vi.stubEnv("DOSU_DEV", "true");
    vi.stubEnv("DOSU_BACKEND_URL_OVERRIDE", "http://127.0.0.1:9");
    const pi = getHookAgent("pi");
    pi?.enable();
    const source = readFileSync(pi?.configPath() as string, "utf-8");
    expect(source).toContain(JSON.stringify(process.execPath));
    expect(source).toContain('"DOSU_DEV":"true"');
    expect(source).toContain('"DOSU_BACKEND_URL_OVERRIDE":"http://127.0.0.1:9"');
  });
});

describe("the Dosu pi extension", () => {
  it("hands the session that ended to the sync hook, which reads it as ended", async () => {
    const pi = await loadExtension();
    const transcript = join(fakeHome, ".pi", "agent", "sessions", "--work--", TRANSCRIPT_NAME);

    await pi.handlers.get("session_shutdown")?.({ reason: "quit" }, piContext([], transcript));

    const [call] = await handedOff(1);
    expect(call.argv).toEqual(["knowledge", "sync", "--quiet", "--detach"]);
    expect(call.cwd).toBe(cwd);
    expect(endedSessionOf(JSON.parse(call.input))).toEqual({
      harness: "pi",
      id: "01a0fdc5-a112",
      path: transcript,
    });
  });

  it("names no session for a reload, or for a session pi never saved", async () => {
    const pi = await loadExtension();
    const shutdown = pi.handlers.get("session_shutdown");

    await shutdown?.({ reason: "reload" }, piContext([], "/x/a_01a0fdc5-a112.jsonl"));
    expect(calls()).toEqual([]);

    // `pi --no-session`: still a trigger for the backlog, with nothing of its own to ship.
    await shutdown?.({ reason: "quit" }, piContext([], undefined));
    expect((await handedOff(1)).map((c) => [c.argv.join(" "), c.input])).toEqual([
      ["knowledge sync --quiet --detach", ""],
    ]);
  });

  it("adds the memory digest the CLI returns for a prompt, and nothing when there is none", async () => {
    const pi = await loadExtension();
    const beforeStart = pi.handlers.get("before_agent_start");
    replies({ "knowledge context": { stdout: "Dosu memory: the deploy codeword is PELICAN\n" } });

    const result = await beforeStart?.({ prompt: "how do I deploy?" }, piContext());

    expect(result).toEqual({
      message: {
        customType: "dosu-memory",
        content: "Dosu memory: the deploy codeword is PELICAN",
        display: false,
      },
    });
    const [call] = calls();
    expect(call.argv).toEqual(["knowledge", "context", "--agent", "pi", "--format", "plain"]);
    expect(JSON.parse(call.input)).toEqual({
      prompt: "how do I deploy?",
      session_id: "01a0fdc5-a112",
      cwd,
    });

    // Once pi has a transcript for the session, the CLI is told where, so it can tell whether
    // the session began before this prompt.
    const transcript = join(cwd, TRANSCRIPT_NAME);
    await beforeStart?.({ prompt: "and then?" }, piContext([], transcript));
    expect(JSON.parse(calls()[1].input)).toEqual({
      prompt: "and then?",
      session_id: "01a0fdc5-a112",
      cwd,
      transcript_path: transcript,
    });

    replies({});
    expect(await beforeStart?.({ prompt: "and then?" }, piContext())).toBeUndefined();
    replies({ "knowledge context": { stdout: "partial", code: 1 } });
    expect(await beforeStart?.({ prompt: "and then?" }, piContext())).toBeUndefined();
  });

  it("leaves the CLI its own server budget, even when it starts slowly, and stops one that hangs", async () => {
    // The CLI gives the server 4s and gives up on its own, saying why in its debug log. Before
    // that it may spend over a second starting (a freshly installed binary's first run) and on
    // git for the project key; the extension only stops a CLI that never answers.
    const answerNow = join(fakeHome, "answer-now");
    replies({ "knowledge context": { stdout: "Dosu memory: PELICAN\n", waitFor: answerNow } });
    const pi = await loadExtension();
    const beforeStart = pi.handlers.get("before_agent_start");
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    try {
      const slow = beforeStart?.({ prompt: "how do I deploy?" }, piContext());
      vi.advanceTimersByTime(7_000);
      writeFileSync(answerNow, "");
      expect(await slow).toEqual({
        message: { customType: "dosu-memory", content: "Dosu memory: PELICAN", display: false },
      });

      rmSync(answerNow);
      const hung = beforeStart?.({ prompt: "and then?" }, piContext());
      vi.advanceTimersByTime(10_000);
      expect(await hung).toBeUndefined();
    } finally {
      vi.useRealTimers();
    }
  });

  it("connects pi's built-in MCP to Dosu's local proxy for each session", async () => {
    stubRunningInstall({ execPath: testRuntime, script: join(bin, "dosu") });
    const pi = await loadExtension();
    // Loading starts nothing: pi loads extensions for invocations that start no session.
    expect(pi.mcpServers.size).toBe(0);

    pi.handlers.get("session_start")?.({ reason: "startup" }, piContext());
    pi.connect();

    const server = pi.mcpServers.get("dosu");
    // Declared to the model like a built-in tool, not left for codemode or tool_search to find.
    expect(server).toMatchObject({ exposure: "direct", cwd });
    expect(pi.active()).toEqual(["read", "bash", ...DOSU_MCP_NAMES]);
    serve(server);
    expect(calls().map((c) => [c.argv, c.cwd])).toEqual([
      [["mcp", "serve", "--client", "pi"], cwd],
    ]);

    // The same entry `dosu mcp add` writes for every other agent.
    const { proxyCommand } = await import("../mcp/proxy-entry");
    const proxy = proxyCommand("pi");
    expect(server).toMatchObject({ command: proxy?.command, args: proxy?.args, env: proxy?.env });
  });

  it("names the session in each call to Dosu's memory tools, for the proxy to take out", async () => {
    const pi = await loadExtension();
    pi.handlers.get("session_start")?.({ reason: "startup" }, piContext());

    expect(await pi.callTool("mcp__dosu__search_memory", { query: "deploy" })).toEqual({
      ran: "mcp__dosu__search_memory",
      args: { query: "deploy", _dosu_session: "01a0fdc5-a112" },
    });

    // /new or /resume in the same pi, through the same proxy: the session running now.
    const next = withSessionId(piContext(), "02b1e6d7");
    pi.handlers.get("session_start")?.({ reason: "new" }, next);
    pi.connect();
    expect(await pi.callTool("mcp__dosu__get_memory_evidence", { memory_id: "m" }, next)).toEqual({
      ran: "mcp__dosu__get_memory_evidence",
      args: { memory_id: "m", _dosu_session: "02b1e6d7" },
    });
    expect(pi.active()).toEqual(["read", "bash", ...DOSU_MCP_NAMES]);

    // Only this extension's server is the proxy: other servers' tools keep their arguments.
    for (const tool of ["mcp__dosu_memory__search_memory", "mcp__github__search_code", "bash"]) {
      expect(await pi.callTool(tool, { query: "q" })).toEqual({ ran: tool, args: { query: "q" } });
    }
  });

  it("blocks Dosu's memory tools in an incognito session, from any server or script, and nothing else", async () => {
    const pi = await loadExtension();
    pi.handlers.get("session_start")?.({ reason: "startup" }, piContext());
    expect(await pi.callTool("mcp__dosu__search_memory", { query: "x" })).toMatchObject({
      ran: "mcp__dosu__search_memory",
    });

    await pi.print("/dosu-incognito");

    // The server stays connected, unused: hidden from the model, and every call blocked.
    expect(pi.failures).toEqual([]);
    expect(pi.active()).toEqual(["read", "bash"]);
    // A user's own mcp.json entry for Dosu, which pi prefers to the extension's (under any name),
    // and a codemode script's nested calls all pass through tool_call: none reaches Dosu.
    for (const tool of [
      ...DOSU_MCP_NAMES,
      "mcp__dosu_memory__search_memory",
      "mcp__dosu_memory__get_memory_evidence",
    ]) {
      expect(await pi.callTool(tool, { query: "x" })).toEqual({
        blocked: expect.stringContaining("/dosu-incognito"),
      });
    }
    for (const tool of ["bash", "mcp__github__search_code", "codemode"]) {
      expect(await pi.callTool(tool)).toEqual({ ran: tool, args: {} });
    }
    // Nor does the Dosu CLI run from bash, which a session pi does not save (--no-session) leaves
    // the CLI no transcript to check.
    for (const command of [
      "dosu memory search 'deploy'",
      "cd /w && /usr/local/bin/dosu memory evidence m1 --json",
      "npx -y @dosu/cli memory search q",
    ]) {
      expect(await pi.callTool("bash", { command })).toEqual({
        blocked: expect.stringContaining("/dosu-incognito"),
      });
    }
    expect(await pi.callTool("bash", { command: "dosu status" })).toMatchObject({ ran: "bash" });
  });

  it("leaves a pi without built-in MCP, or one that refuses the server, running", async () => {
    replies({ "knowledge context": { stdout: "Dosu memory: PELICAN\n" } });
    const old = await loadExtension({ mcp: false });
    old.handlers.get("session_start")?.({ reason: "startup" }, piContext());
    expect(await old.handlers.get("before_agent_start")?.({ prompt: "q" }, piContext())).toEqual({
      message: { customType: "dosu-memory", content: "Dosu memory: PELICAN", display: false },
    });

    const refusing = await loadExtension();
    refusing.api.registerMcpServer = () => {
      throw new Error('MCP server "dosu" is registered by another extension');
    };
    expect(() =>
      refusing.handlers.get("session_start")?.({ reason: "startup" }, piContext()),
    ).not.toThrow();
  });

  it('`pi -p "/dosu-incognito" "<task>"` runs the task with Dosu off, and never ships it', async () => {
    const pi = await loadExtension();
    pi.handlers.get("session_start")?.({ reason: "startup" }, piContext());
    replies({ "knowledge context": { stdout: "Dosu memory: the deploy codeword is PELICAN\n" } });

    await pi.print("/dosu-incognito", "fix the failing tests");

    // The task is the run's only turn, and the model reads it after being told Dosu is off.
    expect(pi.failures).toEqual([]);
    expect(pi.modelReads).toHaveLength(1);
    const read = pi.modelReads[0];
    expect(read.at(-1)).toBe("fix the failing tests");
    const note = read.slice(0, -1).join("\n");
    expect(note).toMatch(/do not call the Dosu memory tools/i);
    expect(note).toContain("search_memory");
    expect(note).toContain("get_memory_evidence");
    // No digest was asked for, and the memory tools are hidden -- from the run's request too,
    // although the server connected only after /dosu-incognito -- and blocked.
    expect(calls()).toEqual([]);
    expect(pi.toolReads).toEqual([["read", "bash"]]);
    expect(pi.active()).toEqual(["read", "bash"]);
    expect(await pi.callTool("mcp__dosu__search_memory", { query: "x" })).toEqual({
      blocked: expect.stringContaining("/dosu-incognito"),
    });
    // The transcript pi saves is one the sync keeps off the record.
    const saved = savedSession(pi.entries);
    expect(saved && isIncognitoSession(saved)).toBe(true);
  });

  it("mid-run, /dosu-incognito records the opt-out at once and steers the note into the run", async () => {
    const pi = await loadExtension({ hasUI: true });
    pi.handlers.get("session_start")?.({ reason: "startup" }, piContext());
    pi.entries.push(userTurn("refactor the parser"));
    pi.startRun();

    await pi.print("/dosu-incognito");

    // Already in the transcript pi is writing: quitting before the run ends still keeps it off.
    const saved = savedSession(pi.entries);
    expect(saved && isIncognitoSession(saved)).toBe(true);
    expect(pi.steered.map((m) => m.content).join("\n")).toMatch(
      /do not call the Dosu memory tools/i,
    );
    expect(pi.active()).toEqual(["read", "bash"]);
  });

  it("says so when a print run ends on /dosu-incognito with nothing for pi to save", async () => {
    const stderr = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    const unsaved = join(fakeHome, "never-written.jsonl");

    const pi = await loadExtension();
    await pi.print("/dosu-incognito");
    await pi.handlers.get("session_shutdown")?.({ reason: "quit" }, pi.context(unsaved));
    expect(stderr.mock.calls.join("")).toContain('pi -p "/dosu-incognito" "<task>"');

    // Pi's TUI showed the note already; and a session that ran is saved and off the record.
    stderr.mockClear();
    for (const [options, messages] of [
      [{ hasUI: true }, ["/dosu-incognito"]],
      [{}, ["/dosu-incognito", "fix it"]],
    ] as const) {
      const other = await loadExtension(options);
      await other.print(...messages);
      const saved = savedSession(other.entries)?.path;
      await other.handlers.get("session_shutdown")?.(
        { reason: "quit" },
        other.context(saved ?? unsaved),
      );
    }
    expect(stderr.mock.calls.join("")).not.toContain("/dosu-incognito");
  });

  it("/dosu-incognito runs no task given after it, and says so rather than lose it", async () => {
    const stderr = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    const unsaved = join(fakeHome, "never-written.jsonl");

    // `pi -p "/dosu-incognito <task>"`: Dosu goes off, and stderr says the task did not run and
    // how to give it.
    const pi = await loadExtension();
    await pi.print("/dosu-incognito fix the failing tests");
    await pi.handlers.get("session_shutdown")?.({ reason: "quit" }, pi.context(unsaved));
    expect(pi.failures).toEqual([]);
    expect(pi.modelReads).toEqual([]);
    expect(pi.active()).toEqual(["read", "bash"]);
    const said = stderr.mock.calls.join("");
    expect(said).toContain("/dosu-incognito takes no task");
    expect(said).toContain('pi -p "/dosu-incognito" "<task>"');
    expect(said).not.toContain("nothing ran");

    // In the TUI the task goes back in the editor, an Enter away from running with Dosu off.
    stderr.mockClear();
    const tui = await loadExtension({ hasUI: true });
    await tui.print("/dosu-incognito  fix the failing tests ");
    expect(tui.modelReads).toEqual([]);
    expect(tui.editorText()).toBe("fix the failing tests");
    expect(tui.notices).toEqual([
      { message: expect.stringContaining("/dosu-incognito takes no task"), type: "warning" },
    ]);
    expect(stderr).not.toHaveBeenCalled();
    await tui.print(tui.editorText());
    expect(tui.modelReads.at(-1)?.at(-1)).toBe("fix the failing tests");
    expect(calls().filter((call) => call.argv[1] === "context")).toEqual([]);
    const saved = savedSession(tui.entries);
    expect(saved && isIncognitoSession(saved)).toBe(true);
  });

  it("a resumed session that went incognito stays off", async () => {
    // The record /dosu-incognito leaves, and the user turn extensions before it sent instead.
    const records = [
      { type: "custom", customType: "dosu-incognito", data: { marker: "dosu:incognito:v1" } },
      userTurn("Dosu incognito marker: dosu:incognito:v1"),
    ];
    for (const record of records) {
      const pi = await loadExtension();
      pi.handlers.get("session_start")?.({ reason: "resume" }, piContext([userTurn("hi"), record]));

      expect(pi.mcpServers.has("dosu")).toBe(false);
      expect(pi.active()).toEqual(["read", "bash"]);
      expect(await pi.callTool("mcp__dosu__get_memory_evidence", { memory_id: "m" })).toEqual({
        blocked: expect.stringContaining("/dosu-incognito"),
      });
      expect(await pi.handlers.get("before_agent_start")?.({ prompt: "q" }, piContext())).toBe(
        undefined,
      );
    }
    expect(calls()).toEqual([]);
  });

  it("a fork or clone of an incognito session stays off, at any depth", async () => {
    const transcript = (name: string, entries: unknown[], parentSession?: string) => {
      const path = join(fakeHome, `${name}.jsonl`);
      const header = { type: "session", id: name, cwd, parentSession };
      writeFileSync(path, `${[header, ...entries].map((e) => JSON.stringify(e)).join("\n")}\n`);
      return path;
    };
    const incognito = transcript("incognito", [
      userTurn("hi"),
      { type: "custom", customType: "dosu-incognito", data: { marker: "dosu:incognito:v1" } },
    ]);
    const legacy = transcript("legacy", [
      userTurn("hi"),
      userTurn("Dosu incognito marker: dosu:incognito:v1"),
    ]);
    // Forked before the marker: the copy has the work, not the marker.
    const fork = transcript("fork", [userTurn("hi")], incognito);
    const plain = transcript("plain", [userTurn("hi")]);

    for (const parent of [incognito, legacy, fork]) {
      const pi = await loadExtension();
      pi.handlers.get("session_start")?.(
        { reason: "fork" },
        piContext([userTurn("hi")], undefined, parent),
      );
      expect(pi.mcpServers.has("dosu")).toBe(false);
      expect(pi.active()).toEqual(["read", "bash"]);
      expect(await pi.handlers.get("before_agent_start")?.({ prompt: "q" }, piContext())).toBe(
        undefined,
      );
    }
    expect(calls()).toEqual([]);

    // A fork of a session that never went incognito keeps Dosu on.
    const pi = await loadExtension();
    pi.handlers.get("session_start")?.(
      { reason: "fork" },
      piContext([userTurn("hi")], undefined, plain),
    );
    pi.connect();
    expect(pi.mcpServers.has("dosu")).toBe(true);
    expect(pi.active()).toEqual(["read", "bash", ...DOSU_MCP_NAMES]);
  });

  it("never breaks pi when the CLI is missing", async () => {
    const pi = await loadExtension();
    vi.stubEnv("PATH", join(fakeHome, "empty"));

    pi.handlers.get("session_start")?.({ reason: "startup" }, piContext());
    expect(await pi.handlers.get("before_agent_start")?.({ prompt: "q" }, piContext())).toBe(
      undefined,
    );
    await pi.handlers.get("session_shutdown")?.({ reason: "quit" }, piContext([], "/x/a_b.jsonl"));
  });
});
