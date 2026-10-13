/** `dosu memory search|evidence` against a local streamable-HTTP server standing in for Dosu's
 * MCP endpoint: the same relay and headers as `dosu mcp serve`, from a real git checkout. */

import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { saveConfig } from "../config/config";
import { type FlatTestConfig, makeTestConfig } from "../config/config.test-utils";
import { type FakeMcpServer, startFakeMcpServer } from "../mcp/mcp-server.test-utils";
import { makeOpencodeDb, opencodeDocument } from "../sessions/opencode.test-utils";
import { INCOGNITO_MARKER, PI_INCOGNITO_ENTRY_TYPE } from "../sync/incognito";
import { emptySyncState, saveSyncState, setAgentsIncognito } from "../sync/state";
import { memoryCommand } from "./memory";

let home: string;
let server: FakeMcpServer;
let origCwd: string;
let out: string[];
let err: string[];

beforeEach(async () => {
  home = realpathSync(mkdtempSync(join(tmpdir(), "dosu-memory-cmd-")));
  origCwd = process.cwd();
  server = await startFakeMcpServer();
  vi.stubEnv("HOME", home);
  vi.stubEnv("XDG_CONFIG_HOME", join(home, ".config"));
  vi.stubEnv("DOSU_DEV", undefined);
  vi.stubEnv("DOSU_PROJECT", undefined);
  vi.stubEnv("DOSU_BACKEND_URL_OVERRIDE", server.baseUrl);
  out = [];
  err = [];
  vi.spyOn(console, "log").mockImplementation((...args: unknown[]) => {
    out.push(args.join(" "));
  });
  vi.spyOn(console, "error").mockImplementation((...args: unknown[]) => {
    err.push(args.join(" "));
  });
  setUp();
});

afterEach(async () => {
  process.chdir(origCwd);
  process.exitCode = undefined;
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  await server.close();
  rmSync(home, { recursive: true, force: true });
});

function setUp(overrides: Partial<FlatTestConfig> = {}): void {
  saveConfig(
    makeTestConfig({
      access_token: "t",
      refresh_token: "r",
      expires_at: 0,
      api_key: "sk_test",
      deployment_id: "dep1",
      ...overrides,
    }),
  );
}

/** A clone with history and no origin remote, on `branch`; the cwd moves into it. */
function inNoOriginClone(branch: string): string {
  const dir = join(home, "work", "widget");
  mkdirSync(dir, { recursive: true });
  const git = (...args: string[]) =>
    execFileSync("git", ["-C", dir, "-c", "user.name=t", "-c", "user.email=t@t", ...args], {
      encoding: "utf-8",
    });
  git("init", "-q", "-b", branch);
  git("commit", "-q", "--allow-empty", "-m", "root");
  process.chdir(dir);
  return git("rev-list", "--max-parents=0", "HEAD").trim();
}

async function dosu(...args: string[]): Promise<void> {
  const cmd = memoryCommand();
  cmd.exitOverride();
  await cmd.parseAsync(["node", "dosu", ...args]);
}

describe("dosu memory search", () => {
  it("prints the search_memory result, scoped like the agent's MCP session", async () => {
    const root = inNoOriginClone("main");

    await dosu("search", "how do we deploy", "--client", "pi");

    expect(out.join("\n")).toBe(
      `memories for "how do we deploy" (project=git:${root} repo=git:${root} branch=main client=pi)`,
    );
    const methods = server.requests.map((r) => r.body?.method);
    expect(methods).toEqual(["initialize", "notifications/initialized", "tools/call"]);
    expect(server.requests[2].body.params).toEqual({
      name: "search_memory",
      arguments: { query: "how do we deploy" },
    });
    expect(server.requests[2].path).toBe("/v2/mcp/deployments/dep1");
    expect(server.requests[2].headers["x-dosu-api-key"]).toBe("sk_test");
    expect(process.exitCode ?? 0).toBe(0);
  });

  it("prints the whole tool result with --json", async () => {
    inNoOriginClone("main");

    await dosu("search", "q", "--json");

    expect(JSON.parse(out.join("\n"))).toEqual({
      content: [{ type: "text", text: expect.stringContaining('memories for "q"') }],
    });
    expect(server.requests[2].headers["x-dosu-client"]).toBeUndefined();
  });

  it("exits 1 with the server's error when the request fails", async () => {
    await server.close();
    server = await startFakeMcpServer({
      intercept: (_body, res) => {
        res.writeHead(401, { "content-type": "application/json" });
        res.end(JSON.stringify({ error: "invalid_token", error_description: "API key revoked" }));
        return true;
      },
    });
    vi.stubEnv("DOSU_BACKEND_URL_OVERRIDE", server.baseUrl);

    await dosu("search", "q");

    expect(process.exitCode).toBe(1);
    expect(out).toEqual([]);
    expect(err.join("\n")).toContain("API key revoked");
  });

  it("exits 1 with the remedy when Dosu is not set up", async () => {
    setUp({ api_key: undefined });

    await dosu("search", "q");

    expect(process.exitCode).toBe(1);
    expect(err.join("\n")).toContain("dosu setup");
    expect(server.requests).toEqual([]);
  });

  it("refuses OSS mode, whose public endpoint has no memory", async () => {
    setUp({ mode: "oss", deployment_id: undefined });

    await dosu("search", "q");

    expect(process.exitCode).toBe(1);
    expect(err.join("\n")).toContain("Dosu Cloud");
    expect(server.requests).toEqual([]);
  });
});

describe("dosu memory evidence", () => {
  it("prints the get_memory_evidence result", async () => {
    inNoOriginClone("main");

    await dosu("evidence", "0b0e0f00-0000-4000-8000-000000000001", "--client", "pi");

    expect(out.join("\n")).toBe("evidence 0b0e0f00-0000-4000-8000-000000000001");
    expect(server.requests[2].body.params).toEqual({
      name: "get_memory_evidence",
      arguments: { memory_id: "0b0e0f00-0000-4000-8000-000000000001" },
    });
    expect(server.requests[2].headers["x-dosu-client"]).toBe("pi");
  });

  it("exits 1 on a tool error, with its text on stderr", async () => {
    inNoOriginClone("main");

    await dosu("evidence", "missing");

    expect(process.exitCode).toBe(1);
    expect(out).toEqual([]);
    expect(err.join("\n")).toContain("no such memory");
  });

  it("prints a tool error's result with --json and still exits 1", async () => {
    inNoOriginClone("main");

    await dosu("evidence", "missing", "--json");

    expect(process.exitCode).toBe(1);
    expect(JSON.parse(out.join("\n"))).toMatchObject({ isError: true });
  });
});

describe("the session a dosu memory call belongs to", () => {
  /** A pi session file, with the extension's incognito record when `incognito`. */
  function piTranscript(incognito: boolean): string {
    const path = join(home, ".pi", "agent", "sessions", "--w--", "2026-10-05_pi-s1.jsonl");
    mkdirSync(dirname(path), { recursive: true });
    const lines = [{ type: "session", id: "pi-s1", cwd: "/w", timestamp: "2026-10-05T00:00:00Z" }];
    if (incognito) {
      lines.push({
        type: "custom",
        customType: PI_INCOGNITO_ENTRY_TYPE,
        data: { marker: INCOGNITO_MARKER },
      } as never);
    }
    writeFileSync(path, `${lines.map((l) => JSON.stringify(l)).join("\n")}\n`);
    return path;
  }

  it("names the session the caller passes", async () => {
    inNoOriginClone("main");
    const transcript = piTranscript(false);

    await dosu("search", "q", "--client", "pi", "--session", "pi-s1", "--transcript", transcript);
    await dosu("evidence", "m1", "--client", "pi", "--session", "pi-s1");

    const calls = server.requests.filter((r) => r.body?.method === "tools/call");
    expect(calls.map((r) => r.headers["x-dosu-session"])).toEqual(["pi-s1", "pi-s1"]);
  });

  it("names the agent session it runs in from its shell's environment", async () => {
    inNoOriginClone("main");
    const transcript = piTranscript(false);
    // What pi sets for every command its bash tool runs.
    vi.stubEnv("PI_CODING_AGENT", "true");
    vi.stubEnv("AI_AGENT", "pi");
    vi.stubEnv("PI_SESSION_ID", "pi-s1");
    vi.stubEnv("PI_SESSION_FILE", transcript);

    await dosu("search", "q");
    // Inherited from the Claude Code shell pi was started from: which agent's model runs the
    // command is no longer certain, so the call is named under neither session.
    vi.stubEnv("CLAUDECODE", "1");
    vi.stubEnv("CLAUDE_CODE_SESSION_ID", "claude-outer");
    await dosu("search", "q");

    const calls = server.requests.filter((r) => r.body?.method === "tools/call");
    expect(calls.map((r) => [r.headers["x-dosu-session"], r.headers["x-dosu-client"]])).toEqual([
      ["pi-s1", "pi"],
      [undefined, undefined],
    ]);
  });

  it("sends nothing when the agent session it runs in is off the record", async () => {
    inNoOriginClone("main");
    vi.stubEnv("PI_CODING_AGENT", "true");
    vi.stubEnv("AI_AGENT", "pi");
    vi.stubEnv("PI_SESSION_ID", "pi-s1");
    vi.stubEnv("PI_SESSION_FILE", piTranscript(true));

    await dosu("search", "q");
    await dosu("evidence", "m1", "--json");

    expect(server.requests).toEqual([]);
    expect(err.join("\n")).toContain("Dosu is off for this session");
    expect(process.exitCode).toBe(1);
  });

  it("sends nothing from a Claude Code or Codex session that is off the record", async () => {
    inNoOriginClone("main");
    const marker = `{"type":"user","message":{"content":"<command-name>/dosu-incognito</command-name>"}}\n`;
    const claude = join(home, ".claude", "projects", "-w", "c-off.jsonl");
    mkdirSync(dirname(claude), { recursive: true });
    writeFileSync(claude, marker);
    vi.stubEnv("CLAUDE_CONFIG_DIR", undefined);
    vi.stubEnv("CLAUDECODE", "1");
    vi.stubEnv("CLAUDE_CODE_SESSION_ID", "c-off");
    await dosu("search", "q");

    vi.stubEnv("CLAUDECODE", undefined);
    vi.stubEnv("CLAUDE_CODE_SESSION_ID", undefined);
    const thread = "01a10e94-7647-7512-abec-a5b6e626da5f";
    const rollout = join(
      home,
      ".codex",
      "sessions",
      "2026",
      "10",
      "05",
      `rollout-x-${thread}.jsonl`,
    );
    mkdirSync(dirname(rollout), { recursive: true });
    writeFileSync(
      rollout,
      `{"type":"session_meta"}\n{"text":"Dosu incognito marker: ${INCOGNITO_MARKER}"}\n`,
    );
    vi.stubEnv("CODEX_HOME", undefined);
    vi.stubEnv("CODEX_THREAD_ID", thread);
    await dosu("search", "q");

    expect(server.requests).toEqual([]);
  });

  it("sends nothing for a session the user took off the record", async () => {
    inNoOriginClone("main");
    const transcript = piTranscript(true);

    await dosu("search", "q", "--client", "pi", "--session", "pi-s1", "--transcript", transcript);

    expect(server.requests).toEqual([]);
    expect(err.join("\n")).toContain("Dosu is off for this session");
    expect(process.exitCode).toBe(1);
  });

  it("sends nothing for an agent in incognito, named by --client or by its shell", async () => {
    inNoOriginClone("main");
    const transcript = piTranscript(false);
    setAgentsIncognito(["pi"], true);

    // A person asking as pi, with or without a session, and pi's own model from its bash tool.
    await dosu("search", "q", "--client", "pi");
    await dosu("evidence", "m1", "--client", "pi", "--session", "pi-s1");
    vi.stubEnv("PI_SESSION_ID", "pi-s1");
    vi.stubEnv("PI_SESSION_FILE", transcript);
    await dosu("search", "q");

    expect(server.requests).toEqual([]);
    expect(err).toHaveLength(3);
    for (const line of err) expect(line).toContain("'dosu knowledge incognito off pi'");
    expect(process.exitCode).toBe(1);

    // Another agent's switch holds no call of pi's back.
    process.exitCode = undefined;
    setAgentsIncognito(["pi"], false);
    setAgentsIncognito(["codex"], true);
    await dosu("search", "q");
    expect(server.requests.filter((r) => r.body?.method === "tools/call")).toHaveLength(1);
  });

  it("sends nothing from Cursor's agent shell while Cursor is in incognito", async () => {
    // Cursor names no session in its shell, but marks the commands its agent runs.
    inNoOriginClone("main");
    vi.stubEnv("CURSOR_AGENT", "1");
    setAgentsIncognito(["cursor"], true);

    await dosu("search", "secret cursor task text");
    expect(server.requests).toEqual([]);
    expect(err.join("\n")).toContain("'dosu knowledge incognito off cursor'");
    expect(process.exitCode).toBe(1);

    process.exitCode = undefined;
    setAgentsIncognito(["cursor"], false);
    await dosu("search", "q");
    expect(server.requests.filter((r) => r.body?.method === "tools/call")).toHaveLength(1);
  });

  it("holds a call that names a session but no agent to the shell's session too", async () => {
    inNoOriginClone("main");
    vi.stubEnv("CLAUDE_CODE_SESSION_ID", "c-live");
    setAgentsIncognito(["claude"], true);

    // Another id, or the shell's own, with no --client to say whose: neither goes out.
    await dosu("search", "secret query", "--session", "abc");
    await dosu("search", "secret query", "--session", "c-live");

    expect(server.requests.filter((r) => r.body?.method === "tools/call")).toEqual([]);
    expect(err).toHaveLength(2);
  });

  it("sends nothing for a session that ran while its agent was incognito", async () => {
    inNoOriginClone("main");
    saveSyncState({
      ...emptySyncState(),
      sessions: {
        "pi/pi-s1": {
          updated: "2026-10-05T00:00:00.000Z",
          outcome: "incognito",
          at: "2026-10-05T00:10:00.000Z",
          cli_version: "0.67.0",
          by_agent: true,
        },
      },
    });

    await dosu("search", "q", "--client", "pi", "--session", "pi-s1");

    expect(server.requests).toEqual([]);
    expect(err.join("\n")).toContain("ran while its agent was incognito");
    expect(process.exitCode).toBe(1);
  });
});

describe("dosu memory run from an agent's shell", () => {
  // An agent's model can run `dosu memory` itself, passing nothing: the session is the one the
  // agent's shell environment names.
  const INCOGNITO_TURN = `{"type":"user","message":{"content":"<command-name>/dosu-incognito</command-name>"}}\n`;
  const thread = "01a10e60-e400-7590-875d-37ca506279ac";
  const stem = `rollout-2026-10-05T16-23-13-${thread}`;

  function write(path: string, text: string): void {
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, text);
  }

  function claudeSession(id: string, incognito: boolean): void {
    write(
      join(home, ".claude", "projects", "-w", `${id}.jsonl`),
      incognito ? INCOGNITO_TURN : "{}\n",
    );
  }

  function codexRollout(incognito: boolean): void {
    const marker = incognito ? `{"text":"Dosu incognito marker: ${INCOGNITO_MARKER}"}\n` : "";
    write(
      join(home, ".codex", "sessions", "2026", "10", "05", `${stem}.jsonl`),
      `{"type":"session_meta"}\n${marker}`,
    );
  }

  const calls = () => server.requests.filter((r) => r.body?.method === "tools/call");

  beforeEach(() => inNoOriginClone("main"));

  it("names a Claude Code shell's session, and the agent", async () => {
    claudeSession("s-live", false);
    vi.stubEnv("CLAUDE_CODE_SESSION_ID", "s-live");

    await dosu("search", "q");

    expect(calls().map((r) => [r.headers["x-dosu-session"], r.headers["x-dosu-client"]])).toEqual([
      ["s-live", "claude-code"],
    ]);
  });

  it("names a Codex shell's session by its thread's rollout", async () => {
    codexRollout(false);
    vi.stubEnv("CODEX_THREAD_ID", thread);

    await dosu("evidence", "m1");

    expect(calls().map((r) => [r.headers["x-dosu-session"], r.headers["x-dosu-client"]])).toEqual([
      [stem, "codex"],
    ]);
  });

  it("names an OpenCode shell's session, as Dosu's plugin gives it, and keeps off the record", async () => {
    vi.stubEnv("XDG_DATA_HOME", join(home, ".local", "share"));
    const db = join(home, ".local", "share", "opencode", "opencode.db");
    mkdirSync(dirname(db), { recursive: true });
    const off = opencodeDocument({ id: "ses_off", user: `/dosu-incognito ${INCOGNITO_MARKER}` });
    if (!makeOpencodeDb(db, [opencodeDocument({ id: "ses_live" }), off])) return; // no sqlite

    vi.stubEnv("DOSU_OPENCODE_SESSION", "ses_live");
    await dosu("search", "q");
    vi.stubEnv("DOSU_OPENCODE_SESSION", "ses_off");
    await dosu("search", "q");

    expect(calls().map((r) => [r.headers["x-dosu-session"], r.headers["x-dosu-client"]])).toEqual([
      ["ses_live", "opencode"],
    ]);
    expect(err.join("\n")).toContain("Dosu is off for this session");
  });

  it("sends nothing from the shell of a session the user took off the record", async () => {
    claudeSession("s-off", true);
    codexRollout(true);

    vi.stubEnv("CLAUDE_CODE_SESSION_ID", "s-off");
    await dosu("search", "q");
    vi.stubEnv("CLAUDE_CODE_SESSION_ID", undefined);
    vi.stubEnv("CODEX_THREAD_ID", thread);
    await dosu("evidence", "m1");

    expect(server.requests).toEqual([]);
    expect(err.join("\n")).toContain("Dosu is off for this session");
    expect(process.exitCode).toBe(1);
  });

  it("holds an agent run from another's shell to both sessions, and names neither", async () => {
    claudeSession("s-off", true);
    codexRollout(false);
    vi.stubEnv("CLAUDE_CODE_SESSION_ID", "s-off");
    vi.stubEnv("CODEX_THREAD_ID", thread);

    await dosu("search", "q");
    expect(server.requests).toEqual([]);

    claudeSession("s-live", false);
    vi.stubEnv("CLAUDE_CODE_SESSION_ID", "s-live");
    await dosu("search", "q");
    expect(calls().map((r) => r.headers["x-dosu-session"])).toEqual([undefined]);
  });

  it("with --client, looks only at that agent's session", async () => {
    claudeSession("s-off", true);
    codexRollout(false);
    vi.stubEnv("CLAUDE_CODE_SESSION_ID", "s-off");
    vi.stubEnv("CODEX_THREAD_ID", thread);

    await dosu("search", "q", "--client", "codex");

    expect(calls().map((r) => r.headers["x-dosu-session"])).toEqual([stem]);
  });
});
