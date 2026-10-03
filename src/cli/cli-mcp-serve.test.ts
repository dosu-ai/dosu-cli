/** `dosu mcp serve` as an agent runs it: JSON-RPC lines on stdin, a temporary home with a real
 * config and git checkout, and a local streamable-HTTP server standing in for Dosu. */

import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { saveConfig } from "../config/config";
import { makeTestConfig } from "../config/config.test-utils";
import { type FakeMcpServer, startFakeMcpServer } from "../mcp/mcp-server.test-utils";
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

async function serve(lines: unknown[], ...flags: string[]): Promise<void> {
  vi.spyOn(process, "stdin", "get").mockReturnValue(
    Readable.from(
      lines.map((line) => (typeof line === "string" ? line : `${JSON.stringify(line)}\n`)),
    ) as unknown as typeof process.stdin,
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
