/** `dosu memory search|evidence` against a local streamable-HTTP server standing in for Dosu's
 * MCP endpoint: the same relay and headers as `dosu mcp serve`, from a real git checkout. */

import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { saveConfig } from "../config/config";
import { type FlatTestConfig, makeTestConfig } from "../config/config.test-utils";
import { type FakeMcpServer, startFakeMcpServer } from "../mcp/mcp-server.test-utils";
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
