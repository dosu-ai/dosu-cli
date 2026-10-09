/** `dosu mcp serve` as an agent runs it: JSON-RPC lines on stdin, a temporary home with a real
 * config and git checkout, and a local streamable-HTTP server standing in for Dosu. */

import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { Readable } from "node:stream";
import { pathToFileURL } from "node:url";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { saveConfig } from "../config/config";
import { makeTestConfig } from "../config/config.test-utils";
import { type FakeMcpServer, startFakeMcpServer } from "../mcp/mcp-server.test-utils";
import { contextHookOutput } from "../memory/context-hook";
import { makeOpencodeDb, opencodeDocument } from "../sessions/opencode.test-utils";
import { INCOGNITO_MARKER } from "../sync/incognito";
import { emptySyncState, saveSyncState, setAgentsIncognito } from "../sync/state";
import { createProgram } from "./cli";

let home: string;
let server: FakeMcpServer;
let origCwd: string;
let stdout: string[];
let stderr: string[];

beforeEach(async () => {
  home = realpathSync(mkdtempSync(join(tmpdir(), "dosu-mcp-serve-")));
  origCwd = process.cwd();
  server = await startFakeMcpServer();
  vi.stubEnv("HOME", home);
  vi.stubEnv("XDG_CONFIG_HOME", join(home, ".config"));
  vi.stubEnv("DOSU_DEV", undefined);
  vi.stubEnv("DOSU_PROJECT", undefined);
  vi.stubEnv("DOSU_BACKEND_URL_OVERRIDE", server.baseUrl);
  stdout = [];
  stderr = [];
  vi.spyOn(process.stdout, "write").mockImplementation((chunk: string | Uint8Array) => {
    stdout.push(String(chunk));
    return true;
  });
  vi.spyOn(process.stderr, "write").mockImplementation((chunk: string | Uint8Array) => {
    stderr.push(String(chunk));
    return true;
  });
  vi.spyOn(console, "error").mockImplementation((...args: unknown[]) => {
    stderr.push(args.join(" "));
  });
});

afterEach(async () => {
  process.chdir(origCwd);
  process.exitCode = undefined;
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  await server.close();
  rmSync(home, { recursive: true, force: true });
});

function setUp(): void {
  saveConfig(
    makeTestConfig({
      access_token: "t",
      refresh_token: "r",
      expires_at: 0,
      api_key: "sk_test",
      deployment_id: "dep1",
    }),
  );
}

/** A clone with history but no origin remote, checked out on `branch`. */
function noOriginClone(branch: string): { dir: string; root: string } {
  const dir = join(home, "work", "widget");
  mkdirSync(dir, { recursive: true });
  const git = (...args: string[]) =>
    execFileSync("git", ["-C", dir, "-c", "user.name=t", "-c", "user.email=t@t", ...args], {
      encoding: "utf-8",
    });
  git("init", "-q", "-b", branch);
  git("commit", "-q", "--allow-empty", "-m", "root");
  git("commit", "-q", "--allow-empty", "-m", "second");
  return { dir, root: git("rev-list", "--max-parents=0", "HEAD").trim() };
}

async function serve(lines: Iterable<unknown> | AsyncIterable<unknown>, ...flags: string[]) {
  async function* asLines() {
    for await (const line of lines) {
      yield typeof line === "string" ? line : `${JSON.stringify(line)}\n`;
    }
  }
  vi.spyOn(process, "stdin", "get").mockReturnValue(
    Readable.from(asLines()) as unknown as typeof process.stdin,
  );
  const program = createProgram();
  program.exitOverride();
  await program.parseAsync(["node", "dosu", "mcp", "serve", ...flags]);
}

const HANDSHAKE = [
  {
    jsonrpc: "2.0",
    id: 1,
    method: "initialize",
    params: {
      protocolVersion: "2025-06-18",
      capabilities: {},
      clientInfo: { name: "a", version: "1" },
    },
  },
  { jsonrpc: "2.0", method: "notifications/initialized" },
];

describe("dosu mcp serve", () => {
  it("relays an agent's session to Dosu with the project, branch, and client of its directory", async () => {
    setUp();
    const { dir, root } = noOriginClone("feature/memory");
    process.chdir(dir);

    await serve(
      [
        ...HANDSHAKE,
        {
          jsonrpc: "2.0",
          id: 2,
          method: "tools/call",
          params: { name: "search_memory", arguments: { query: "how to deploy" } },
        },
      ],
      "--client",
      "codex",
    );

    const replies = stdout
      .join("")
      .split("\n")
      .filter(Boolean)
      .map((line) => JSON.parse(line));
    expect(replies.map((r) => r.id).sort()).toEqual([1, 2]);
    const call = replies.find((r) => r.id === 2);
    expect(call.result.content[0].text).toBe(
      `memories for "how to deploy" (project=git:${root} repo=git:${root} ` +
        "branch=feature/memory client=codex)",
    );
    expect(server.requests).toHaveLength(3);
    for (const request of server.requests) {
      expect(request.path).toBe("/v2/mcp/deployments/dep1");
      expect(request.headers["x-dosu-api-key"]).toBe("sk_test");
    }
    expect(process.exitCode ?? 0).toBe(0);
  });

  it("re-reads the branch for each request", async () => {
    setUp();
    const { dir } = noOriginClone("main");
    process.chdir(dir);
    const call = (id: number) => ({
      jsonrpc: "2.0",
      id,
      method: "tools/call",
      params: { name: "search_memory", arguments: { query: "q" } },
    });
    let checkedOut = false;
    await server.close();
    server = await startFakeMcpServer({
      intercept: (body) => {
        if (body?.id === 2 && !checkedOut) {
          execFileSync("git", ["-C", dir, "checkout", "-q", "-b", "other"]);
          checkedOut = true;
        }
        return false;
      },
    });
    vi.stubEnv("DOSU_BACKEND_URL_OVERRIDE", server.baseUrl);
    const lines = new Readable({ read() {} });
    vi.spyOn(process, "stdin", "get").mockReturnValue(lines as unknown as typeof process.stdin);
    const program = createProgram();
    program.exitOverride();
    const running = program.parseAsync(["node", "dosu", "mcp", "serve"]);
    lines.push(`${JSON.stringify(call(2))}\n`);
    await vi.waitFor(() => expect(stdout.join("")).toContain('"id":2'));
    lines.push(`${JSON.stringify(call(3))}\n`);
    lines.push(null);
    await running;

    expect(server.requests.map((r) => r.headers["x-dosu-branch"])).toEqual(["main", "other"]);
  });

  it("keeps stdout to JSON-RPC lines, answering a line it cannot parse", async () => {
    setUp();
    process.chdir(home);

    await serve(["not json\n", ...HANDSHAKE]);

    const lines = stdout.join("").split("\n").filter(Boolean);
    expect(lines.map((line) => JSON.parse(line))).toEqual([
      { jsonrpc: "2.0", id: null, error: { code: -32700, message: "Parse error" } },
      expect.objectContaining({ id: 1 }),
    ]);
  });

  it("answers the last line even without a trailing newline", async () => {
    setUp();
    process.chdir(home);

    await serve([JSON.stringify(HANDSHAKE[0])]);

    expect(JSON.parse(stdout.join("")).id).toBe(1);
  });

  it("exits 1 with the remedy on stderr, and nothing on stdout, when Dosu is not set up", async () => {
    process.chdir(home);

    await serve(HANDSHAKE);

    expect(process.exitCode).toBe(1);
    expect(stdout).toEqual([]);
    expect(stderr.join("")).toContain("dosu setup");
    expect(server.requests).toEqual([]);
  });

  it("refuses a cloud setup with no deployment selected", async () => {
    saveConfig(
      makeTestConfig({ access_token: "t", refresh_token: "r", expires_at: 0, api_key: "k" }),
    );
    process.chdir(home);

    await serve(HANDSHAKE);

    expect(process.exitCode).toBe(1);
    expect(stderr.join("")).toContain("No Dosu deployment");
  });

  it("refuses a build with no backend URL", async () => {
    setUp();
    vi.stubEnv("DOSU_BACKEND_URL_OVERRIDE", "");
    vi.stubEnv("DOSU_BACKEND_URL", "");
    process.chdir(home);

    await serve(HANDSHAKE);

    expect(process.exitCode).toBe(1);
    expect(stderr.join("")).toContain("backend URL");
  });
});

describe("an agent that starts the proxy outside its workspace", () => {
  // GUI hosts (Cursor, Claude Desktop, VS Code) may start a global server in / or the home
  // directory; MCP roots are how such an agent names the workspace it has open.
  const SEARCH = {
    jsonrpc: "2.0",
    id: 2,
    method: "tools/call",
    params: { name: "search_memory", arguments: { query: "q" } },
  };

  // biome-ignore lint/suspicious/noExplicitAny: JSON-RPC lines are arbitrary JSON
  function lines(): any[] {
    return stdout
      .join("")
      .split("\n")
      .filter(Boolean)
      .map((line) => JSON.parse(line));
  }

  /** A session for an agent that declares the roots capability. When the proxy asks for roots,
   * `answer` gives the agent's reply to that request id; undefined leaves it unanswered. */
  async function session(answer?: (id: unknown) => unknown): Promise<string> {
    const input = new Readable({ read() {} });
    vi.spyOn(process, "stdin", "get").mockReturnValue(input as unknown as typeof process.stdin);
    const program = createProgram();
    program.exitOverride();
    const running = program.parseAsync(["node", "dosu", "mcp", "serve", "--client", "cursor"]);
    const send = (message: unknown) => input.push(`${JSON.stringify(message)}\n`);
    const [initialize, initialized] = HANDSHAKE as [{ params: object }, unknown];
    send({ ...initialize, params: { ...initialize.params, capabilities: { roots: {} } } });
    await vi.waitFor(() => expect(lines().map((m) => m.id)).toContain(1));
    send(initialized);
    if (answer) {
      await vi.waitFor(() => expect(lines().map((m) => m.method)).toContain("roots/list"));
      send(answer(lines().find((m) => m.method === "roots/list").id));
    }
    send(SEARCH);
    await vi.waitFor(() => expect(lines().map((m) => m.id)).toContain(2), { timeout: 5_000 });
    input.push(null);
    await running;
    return lines().find((m) => m.id === 2).result.content[0].text;
  }

  it("scopes the session by the workspace root the agent names", async () => {
    setUp();
    const { dir, root } = noOriginClone("main");
    process.chdir(home);

    const text = await session((id) => ({
      jsonrpc: "2.0",
      id,
      result: { roots: [{ uri: pathToFileURL(dir).href, name: "widget" }] },
    }));

    expect(text).toContain(`project=git:${root} repo=git:${root} branch=main client=cursor`);
    // The agent's answer is the proxy's own business, not the server's.
    expect(server.requests.map((r) => r.body.method)).toEqual([
      "initialize",
      "notifications/initialized",
      "tools/call",
    ]);
  });

  it("asks nothing when the directory it started in has a project of its own", async () => {
    setUp();
    const { dir, root } = noOriginClone("main");
    process.chdir(dir);

    const text = await session();

    expect(text).toContain(`project=git:${root}`);
    expect(lines().map((m) => m.method)).not.toContain("roots/list");
  });

  it("keeps the directory it started in when the agent has no roots to give", async () => {
    setUp();
    process.chdir(home);

    const text = await session((id) => ({
      jsonrpc: "2.0",
      id,
      error: { code: -32601, message: "Method not found" },
    }));

    expect(text).toContain(`project=path:${home} `);
  });

  it("goes on without the roots of an agent that never answers", async () => {
    setUp();
    process.chdir(home);

    const text = await session();

    expect(lines().map((m) => m.method)).toContain("roots/list");
    expect(text).toContain(`project=path:${home} `);
  });
});

describe("the session a tool call belongs to", () => {
  const search = (params: Record<string, unknown> = {}, id = 2) => ({
    jsonrpc: "2.0",
    id,
    method: "tools/call",
    params: { name: "search_memory", arguments: { query: "q" }, ...params },
  });

  // biome-ignore lint/suspicious/noExplicitAny: JSON-RPC replies
  function replies(): Array<Record<string, any>> {
    return stdout
      .join("")
      .split("\n")
      .filter(Boolean)
      .map((line) => JSON.parse(line));
  }

  /** The tools/call requests that reached Dosu. */
  function relayedCalls() {
    return server.requests.filter((r) => r.body?.method === "tools/call");
  }

  function writeFile(path: string, text: string): string {
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, text);
    return path;
  }

  const codexThread = "01a10e60-e400-7590-875d-37ca506279ac";
  const rolloutStem = `rollout-2026-10-05T16-23-13-${codexThread}`;
  const codexMeta = (thread: string) => ({
    _meta: { "x-codex-turn-metadata": { session_id: thread, thread_id: thread }, threadId: thread },
  });

  function codexRollout(text: string): void {
    writeFile(join(home, ".codex", "sessions", "2026", "10", "05", `${rolloutStem}.jsonl`), text);
  }

  beforeEach(() => {
    vi.stubEnv("CLAUDE_CODE_SESSION_ID", undefined);
    vi.stubEnv("CODEX_HOME", undefined);
    setUp();
    process.chdir(noOriginClone("main").dir);
  });

  it("names a Codex call's session by its thread's rollout", async () => {
    codexRollout('{"type":"session_meta"}\n');

    await serve([...HANDSHAKE, search(codexMeta(codexThread))], "--client", "codex");

    expect(relayedCalls().map((r) => r.headers["x-dosu-session"])).toEqual([rolloutStem]);
    expect(replies().find((r) => r.id === 2)?.result.isError).toBeFalsy();
  });

  it("sends nothing for a Codex session the user took off the record", async () => {
    codexRollout(
      `{"type":"session_meta"}\n{"text":"Dosu incognito marker: ${INCOGNITO_MARKER}"}\n`,
    );

    await serve([...HANDSHAKE, search(codexMeta(codexThread))], "--client", "codex");

    expect(relayedCalls()).toEqual([]);
    const reply = replies().find((r) => r.id === 2);
    expect(reply?.result.isError).toBe(true);
    expect(reply?.result.content[0].text).toContain("Dosu is off for this session");
  });

  it("names a Claude Code call's session as its PreToolUse hook recorded it", async () => {
    const transcript = writeFile(join(home, ".claude", "projects", "-w", "s-live.jsonl"), "{}\n");
    vi.stubEnv("CLAUDE_CODE_SESSION_ID", "s-started");
    await contextHookOutput(
      JSON.stringify({
        hook_event_name: "PreToolUse",
        session_id: "s-live",
        transcript_path: transcript,
        tool_name: "mcp__dosu__search_memory",
        tool_input: { query: "q" },
        tool_use_id: "toolu_1",
      }),
      { apiKey: "k", deploymentId: "d", backendUrl: server.baseUrl },
    );

    await serve(
      [
        ...HANDSHAKE,
        search({ _meta: { "claudecode/toolUseId": "toolu_1" } }, 2),
        search({ _meta: { "claudecode/toolUseId": "toolu_2" } }, 3),
      ],
      "--client",
      "claude-code",
    );

    // The second call has no record: the session Claude Code started the server in.
    expect(relayedCalls().map((r) => r.headers["x-dosu-session"])).toEqual(["s-live", "s-started"]);
  });

  it("names a Claude Code subagent's call by the subagent's own session", async () => {
    // A subagent's transcript ships as a session of its own beside its parent's; the hook payload
    // names the parent and the agent.
    const parent = writeFile(join(home, ".claude", "projects", "-w", "s-parent.jsonl"), "{}\n");
    writeFile(
      join(home, ".claude", "projects", "-w", "s-parent", "subagents", "agent-a1.jsonl"),
      "{}\n",
    );
    const hook = (agent: Record<string, string>, toolUseId: string) =>
      contextHookOutput(
        JSON.stringify({
          hook_event_name: "PreToolUse",
          session_id: "s-parent",
          transcript_path: parent,
          tool_name: "mcp__dosu__search_memory",
          tool_input: { query: "q" },
          tool_use_id: toolUseId,
          ...agent,
        }),
        { apiKey: "k", deploymentId: "d", backendUrl: server.baseUrl },
      );
    await hook({ agent_id: "a1", agent_type: "general-purpose" }, "toolu_a1");
    await hook({ agent_id: "a2", agent_type: "general-purpose" }, "toolu_a2");

    await serve(
      [
        ...HANDSHAKE,
        search({ _meta: { "claudecode/toolUseId": "toolu_a1" } }, 2),
        search({ _meta: { "claudecode/toolUseId": "toolu_a2" } }, 3),
      ],
      "--client",
      "claude-code",
    );

    // a2's transcript is not written yet: its id is still the one it will ship under.
    expect(
      relayedCalls()
        .map((r) => r.headers["x-dosu-session"])
        .sort(),
    ).toEqual(["agent-a1", "agent-a2"]);
  });

  it("sends nothing for a Claude Code session the user took off the record", async () => {
    writeFile(
      join(home, ".claude", "projects", "-w", "s-off.jsonl"),
      `{"type":"user","message":{"content":"<command-name>/dosu-incognito</command-name>"}}\n`,
    );
    vi.stubEnv("CLAUDE_CODE_SESSION_ID", "s-off");

    await serve([...HANDSHAKE, search()], "--client", "claude-code");

    expect(relayedCalls()).toEqual([]);
    expect(replies().find((r) => r.id === 2)?.result.isError).toBe(true);
  });

  it("takes an OpenCode call's session from the argument Dosu's plugin adds, and drops it", async () => {
    await serve(
      [...HANDSHAKE, search({ arguments: { query: "q", _dosu_session: "ses_live" } })],
      "--client",
      "opencode",
    );

    const [call] = relayedCalls();
    expect(call?.headers["x-dosu-session"]).toBe("ses_live");
    expect(call?.body.params.arguments).toEqual({ query: "q" });
  });

  it("sends nothing for an OpenCode session the user took off the record", async () => {
    const dbPath = join(home, ".local", "share", "opencode", "opencode.db");
    mkdirSync(dirname(dbPath), { recursive: true });
    const doc = opencodeDocument({ id: "ses_off", user: `/dosu-incognito ${INCOGNITO_MARKER}` });
    if (!makeOpencodeDb(dbPath, doc)) return; // no sqlite builtin

    await serve(
      [...HANDSHAKE, search({ arguments: { query: "q", _dosu_session: "ses_off" } })],
      "--client",
      "opencode",
    );

    expect(relayedCalls()).toEqual([]);
    expect(replies().find((r) => r.id === 2)?.result.isError).toBe(true);
  });

  it("names no session for a call that carries none", async () => {
    await serve([...HANDSHAKE, search()], "--client", "cursor");

    expect(relayedCalls().map((r) => r.headers["x-dosu-session"])).toEqual([undefined]);
  });

  it("takes no Claude Code session from the environment for another agent's server", async () => {
    // Every shell Claude Code runs carries its session, so an agent started from one passes it on
    // to its own server -- here an incognito session that is not the agent's.
    writeFile(
      join(home, ".claude", "projects", "-w", "s-off.jsonl"),
      `{"type":"user","message":{"content":"<command-name>/dosu-incognito</command-name>"}}\n`,
    );
    vi.stubEnv("CLAUDE_CODE_SESSION_ID", "s-off");

    await serve([...HANDSHAKE, search()], "--client", "opencode");
    await serve([...HANDSHAKE, search({}, 3)], "--client", "cursor");

    expect(relayedCalls().map((r) => r.headers["x-dosu-session"])).toEqual([undefined, undefined]);
  });

  it("takes the session argument from OpenCode's and pi's servers only, and drops it from any", async () => {
    codexRollout(
      `{"type":"session_meta"}\n{"text":"Dosu incognito marker: ${INCOGNITO_MARKER}"}\n`,
    );
    const named = { query: "q", _dosu_session: "x" };

    await serve(
      [...HANDSHAKE, search({ ...codexMeta(codexThread), arguments: named })],
      "--client",
      "codex",
    );
    await serve([...HANDSHAKE, search({ arguments: named }, 3)], "--client", "cursor");

    // Codex's thread still decides, and it is off the record.
    expect(replies().find((r) => r.id === 2)?.result.isError).toBe(true);
    const [call] = relayedCalls();
    expect(call?.headers["x-dosu-session"]).toBeUndefined();
    expect(call?.body.params.arguments).toEqual({ query: "q" });
  });

  it("takes a pi call's session from the argument Dosu's extension adds", async () => {
    vi.stubEnv("CLAUDE_CODE_SESSION_ID", "s-outer");

    await serve(
      [...HANDSHAKE, search({ arguments: { query: "q", _dosu_session: "01a10e7d-b836" } })],
      "--client",
      "pi",
    );

    const [call] = relayedCalls();
    expect(call?.headers["x-dosu-session"]).toBe("01a10e7d-b836");
    expect(call?.body.params.arguments).toEqual({ query: "q" });
  });

  it("answers every call to an agent in incognito itself, naming a session or not", async () => {
    saveSyncState({ ...emptySyncState(), incognito_agents: ["codex", "cursor"] });
    codexRollout('{"type":"session_meta"}\n');
    const knowledge = {
      jsonrpc: "2.0",
      id: 3,
      method: "tools/call",
      params: { name: "read_knowledge", arguments: { query: "q" } },
    };
    const list = { jsonrpc: "2.0", id: 4, method: "tools/list" };

    await serve([...HANDSHAKE, search(), knowledge, list], "--client", "cursor");

    // Not only the memory tools: no call reaches Dosu. The handshake and the tool list still do,
    // as for /dosu-incognito.
    expect(relayedCalls()).toEqual([]);
    expect(server.requests.map((r) => r.body?.method)).toEqual(
      expect.arrayContaining(["initialize", "tools/list"]),
    );
    for (const id of [2, 3]) {
      const reply = replies().find((r) => r.id === id);
      expect(reply?.result.isError).toBe(true);
      expect(reply?.result.content[0].text).toContain("'dosu knowledge incognito off cursor'");
    }
    expect(replies().find((r) => r.id === 4)?.result.tools).toBeDefined();

    // A Codex call names its session, on the record: still not sent.
    await serve([...HANDSHAKE, search(codexMeta(codexThread), 5)], "--client", "codex");
    expect(replies().find((r) => r.id === 5)?.result.content[0].text).toContain(
      "'dosu knowledge incognito off codex'",
    );
    // Another agent's server is not held to it.
    await serve([...HANDSHAKE, search({}, 6)], "--client", "claude-code");
    expect(relayedCalls().map((r) => r.body.id)).toEqual([6]);
  });

  it("reads the switch for each call, so one turned on holds from the agent's next call", async () => {
    async function* session() {
      yield* HANDSHAKE;
      yield search({}, 2);
      // A tick for the proxy to take the line it was handed before the user runs the command.
      await new Promise((resolve) => setTimeout(resolve, 10));
      setAgentsIncognito(["codex"], true);
      yield search({}, 3);
    }

    await serve(session(), "--client", "codex");

    expect(relayedCalls().map((r) => r.body.id)).toEqual([2]);
    expect(replies().find((r) => r.id === 3)?.result.isError).toBe(true);
  });

  it("answers a call from a session that ran while its agent was incognito, after it is off", async () => {
    codexRollout('{"type":"session_meta"}\n');
    saveSyncState({
      ...emptySyncState(),
      sessions: {
        [`codex/${rolloutStem}`]: {
          updated: "2026-10-05T16:30:00.000Z",
          outcome: "incognito",
          at: "2026-10-05T16:40:00.000Z",
          cli_version: "0.67.0",
          by_agent: true,
        },
      },
    });

    await serve([...HANDSHAKE, search(codexMeta(codexThread))], "--client", "codex");

    expect(relayedCalls()).toEqual([]);
    const text = replies().find((r) => r.id === 2)?.result.content[0].text;
    expect(text).toContain("ran while its agent was incognito");
  });

  it("answers calls from a fork, branch or subagent of such a session, which no sync has settled", async () => {
    const day = join(home, ".codex", "sessions", "2026", "10", "05");
    codexRollout('{"type":"session_meta"}\n');
    const forkThread = "01a10e60-f000-7590-875d-37ca506279ac";
    writeFile(
      join(day, `rollout-2026-10-05T17-00-00-${forkThread}.jsonl`),
      `${JSON.stringify({ type: "session_meta", payload: { id: forkThread, forked_from_id: codexThread } })}\n`,
    );
    const childThread = "01a10e60-f111-7590-875d-37ca506279ac";
    writeFile(
      join(day, `rollout-2026-10-05T17-10-00-${childThread}.jsonl`),
      `${JSON.stringify({ type: "session_meta", payload: { id: childThread, parent_thread_id: codexThread, thread_source: "subagent" } })}\n`,
    );
    writeFile(join(home, ".claude", "projects", "-w", "s-orig.jsonl"), "{}\n");
    writeFile(
      join(home, ".claude", "projects", "-w", "s-branch.jsonl"),
      `${JSON.stringify({ type: "user", sessionId: "s-branch", forkedFrom: { sessionId: "s-orig" } })}\n`,
    );
    const sealed = {
      updated: "2026-10-05T16:30:00.000Z",
      outcome: "incognito" as const,
      at: "2026-10-05T16:40:00.000Z",
      cli_version: "0.67.0",
      by_agent: true as const,
    };
    saveSyncState({
      ...emptySyncState(),
      sessions: { [`codex/${rolloutStem}`]: sealed, "claude/s-orig": sealed },
    });

    await serve(
      [...HANDSHAKE, search(codexMeta(forkThread), 2), search(codexMeta(childThread), 3)],
      "--client",
      "codex",
    );
    vi.stubEnv("CLAUDE_CODE_SESSION_ID", "s-branch");
    await serve([...HANDSHAKE, search({}, 4)], "--client", "claude-code");

    expect(relayedCalls()).toEqual([]);
    for (const id of [2, 3, 4]) {
      expect(replies().find((r) => r.id === id)?.result.content[0].text).toContain(
        "ran while its agent was incognito",
      );
    }
  });

  it("answers every call itself while the state file cannot be read", async () => {
    // A hand edit gone wrong: whatever agents it kept in incognito, it no longer says.
    const path = join(home, ".config", "dosu-cli", "knowledge-sync.json");
    writeFile(path, '{"incognito_agents": ["claude",]}');

    await serve([...HANDSHAKE, search()], "--client", "claude-code");

    expect(relayedCalls()).toEqual([]);
    const text = replies().find((r) => r.id === 2)?.result.content[0].text;
    expect(text).toContain("cannot tell whether this agent is incognito");
    expect(text).toContain("fix or remove it");
  });

  it("never names the Claude Code session another agent was started from", async () => {
    // pi (or any agent) run from a Claude Code shell inherits CLAUDE_CODE_SESSION_ID; a call from
    // an entry of its own that names no session is not that Claude Code session's.
    vi.stubEnv("CLAUDE_CODE_SESSION_ID", "s-outer");
    writeFile(
      join(home, ".claude", "projects", "-w", "s-outer.jsonl"),
      `{"type":"user","message":{"content":"<command-name>/dosu-incognito</command-name>"}}\n`,
    );

    await serve([...HANDSHAKE, search()], "--client", "pi");

    expect(relayedCalls().map((r) => r.headers["x-dosu-session"])).toEqual([undefined]);
  });
});
