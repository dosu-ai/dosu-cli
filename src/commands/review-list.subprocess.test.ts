/**
 * `dosu review list` through the real CLI entry (`bun run src/index.ts`) against an HTTP tRPC
 * fixture: the child process builds its own client, so these assert what actually crosses the
 * wire (typed procedure paths and inputs), what reaches stdout/stderr, the exit code, and that
 * listing writes nothing — no mutation requests and an unchanged config file.
 */

import { spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import superjson from "superjson";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";

const ORG = "11111111-1111-4111-8111-111111111111";
const LIB_A = "2222222a-2222-4222-8222-222222222222";
const LIB_B = "2222222b-2222-4222-8222-222222222222";
const DEP_A = "3333333a-3333-4333-8333-333333333333";
const DEP_B = "3333333b-3333-4333-8333-333333333333";
const DEP_GONE = "3333333d-3333-4333-8333-333333333333";
const LIB_GONE = "2222222d-2222-4222-8222-222222222222";
const DEP_FOREIGN = "333333f1-3333-4333-8333-333333333333";
const LIB_FOREIGN = "222222f1-2222-4222-8222-222222222222";
const KS_A = "4444444a-4444-4444-8444-444444444444";
const KS_B = "4444444b-4444-4444-8444-444444444444";

const HOUR = 60 * 60 * 1000;
const ago = (ms: number) => new Date(Date.now() - ms).toISOString();

interface Library {
  id: string;
  name: string;
  org_id: string;
}
interface Deployment {
  deployment_id: string;
  name: string;
  space_id: string;
  org_id: string;
  provider_slug: string;
  enabled: boolean;
}
interface Item {
  id: string;
  kind: "doc_change" | "draft_message";
  title: string;
  createdAt: string;
  [key: string]: unknown;
}

/** What the signed-in fixture user can see. Anything absent is deleted or not theirs. */
interface World {
  libraries: Record<string, Library>;
  deployments: Record<string, Deployment>;
  stores: Record<string, string>;
  docs: Record<string, Item[]>;
  drafts: Record<string, Item[]>;
  libraryInfoFails?: boolean;
}

function doc(id: string, title: string, age: number): Item {
  return {
    id,
    kind: "doc_change",
    pageId: `page-${id}`,
    title,
    version: 2,
    type: "document",
    origin: "llm_generated",
    source: "AI generated",
    externalTriggerUrl: null,
    pendingStatus: "PENDING_REVIEW",
    createdAt: ago(age),
  };
}

function draft(id: string, title: string, age: number): Item {
  return {
    id: `draft_message:${id}`,
    kind: "draft_message",
    title,
    body: "draft body",
    threadId: "thread-1",
    createdAt: ago(age),
  };
}

function baseWorld(): World {
  return {
    libraries: {
      [LIB_A]: { id: LIB_A, name: "Library A", org_id: ORG },
      [LIB_B]: { id: LIB_B, name: "Library B", org_id: ORG },
    },
    deployments: {
      [DEP_A]: mcp(DEP_A, "Library A MCP Server", LIB_A),
      [DEP_B]: mcp(DEP_B, "Library B MCP Server", LIB_B),
    },
    stores: { [LIB_A]: KS_A, [LIB_B]: KS_B },
    docs: {
      [KS_A]: [
        doc("aaaaaaaa-0000-4000-8000-000000000001", "Deploying the Widget Service", 2 * HOUR),
        doc("aaaaaaaa-0000-4000-8000-000000000002", "Onboarding Checklist", 72 * HOUR),
      ],
      [KS_B]: [doc("bbbbbbbb-0000-4000-8000-000000000001", "Billing FAQ", 240 * HOUR)],
    },
    drafts: {
      [DEP_A]: [
        draft("aaaaaaaa-0000-4000-8000-00000000000d", "Rotate the widget API key", 4 * HOUR),
      ],
      [DEP_B]: [draft("bbbbbbbb-0000-4000-8000-00000000000d", "Annual billing answer", 5 * HOUR)],
    },
  };
}

function mcp(id: string, name: string, spaceId: string): Deployment {
  return {
    deployment_id: id,
    name,
    space_id: spaceId,
    org_id: ORG,
    provider_slug: "dosu_mcp",
    enabled: true,
  };
}

interface Recorded {
  method: string;
  path: string;
  input: unknown;
}

let world: World = baseWorld();
let requests: Recorded[] = [];
let server: Server;
let baseURL = "";

function trpcError(res: import("node:http").ServerResponse, path: string, code: string) {
  const httpStatus = code === "NOT_FOUND" ? 404 : 500;
  res.writeHead(httpStatus, { "content-type": "application/json" });
  res.end(
    JSON.stringify({
      error: superjson.serialize({
        message: code === "NOT_FOUND" ? "Library not found." : "boom",
        code: code === "NOT_FOUND" ? -32004 : -32603,
        data: { code, httpStatus, path },
      }),
    }),
  );
}

function listPending(input: {
  knowledgeStoreId: string;
  deploymentId?: string;
  since?: string;
  until?: string;
}) {
  const since = input.since ? Date.parse(input.since) : -Infinity;
  const until = input.until ? Date.parse(input.until) : Infinity;
  const all = [
    ...(world.docs[input.knowledgeStoreId] ?? []),
    ...(input.deploymentId ? (world.drafts[input.deploymentId] ?? []) : []),
  ]
    .filter((i) => Date.parse(i.createdAt) >= since && Date.parse(i.createdAt) < until)
    .sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt));
  return { items: all.slice(0, 50), truncated: all.length > 50, total: all.length };
}

function route(path: string, input: unknown): { data: unknown } | { error: string } {
  switch (path) {
    case "knowledgeStore.getBySpaceId": {
      const spaceId = (input as { space_id: string }).space_id;
      const id = world.stores[spaceId];
      return { data: id ? { id, space_id: spaceId, org_id: ORG } : null };
    }
    case "libraries.info": {
      if (world.libraryInfoFails) return { error: "INTERNAL_SERVER_ERROR" };
      const lib = world.libraries[input as string];
      return lib ? { data: { ...lib, deleted_at: null } } : { error: "NOT_FOUND" };
    }
    case "workspaces.get":
      return { data: world.deployments[input as string] ?? null };
    case "review.listPending":
      return { data: listPending(input as Parameters<typeof listPending>[0]) };
    default:
      return { error: "NOT_FOUND" };
  }
}

beforeAll(async () => {
  server = createServer((req, res) => {
    const url = new URL(req.url ?? "/", "http://fixture");
    const path = url.pathname.replace(/^\/api\/cli-trpc\//, "");
    const raw = url.searchParams.get("input");
    const input = raw ? superjson.deserialize(JSON.parse(raw)) : undefined;
    requests.push({ method: req.method ?? "", path, input });
    // Consume any body so a (forbidden) mutation is still recorded rather than hanging.
    req.resume();
    req.on("end", () => {
      const result = req.method === "GET" ? route(path, input) : { error: "METHOD_NOT_SUPPORTED" };
      if ("error" in result) {
        trpcError(res, path, result.error);
        return;
      }
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ result: { data: superjson.serialize(result.data) } }));
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  baseURL = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

let home = "";
let configPath = "";

beforeEach(() => {
  world = baseWorld();
  requests = [];
  home = mkdtempSync(join(tmpdir(), "dosu-review-list-"));
  const configDir = join(home, ".config", "dosu-cli");
  mkdirSync(configDir, { recursive: true });
  configPath = join(configDir, "config.json");
  // Pin the update check so the child never reaches npm.
  writeFileSync(
    join(configDir, "update-check.json"),
    JSON.stringify({ lastCheck: 4102444800000, latestVersion: "0.0.0" }),
  );
});

afterEach(() => {
  rmSync(home, { recursive: true, force: true });
});

function writeTarget(target: Record<string, string> | undefined): string {
  const config = {
    schema_version: 2,
    active_account: {
      user_id: "e2e-user",
      session: { access_token: "fixture-access-token", refresh_token: "r", expires_at: 0 },
      ...(target ? { target } : {}),
    },
  };
  const text = `${JSON.stringify(config, null, 2)}\n`;
  writeFileSync(configPath, text);
  return text;
}

function selectLibrary(spaceId: string, deploymentId?: string): string {
  return writeTarget({
    org_id: ORG,
    space_id: spaceId,
    ...(deploymentId ? { deployment_id: deploymentId, api_key: "fixture-api-key" } : {}),
  });
}

function runCli(
  ...args: string[]
): Promise<{ status: number | null; stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn("bun", ["run", "src/index.ts", "review", "list", ...args], {
      cwd: process.cwd(),
      env: {
        ...process.env,
        HOME: home,
        XDG_CONFIG_HOME: join(home, ".config"),
        CLAUDE_CONFIG_DIR: join(home, ".claude"),
        DOSU_DEV: "false",
        DOSU_WEB_APP_URL_OVERRIDE: baseURL,
        DOSU_BACKEND_URL_OVERRIDE: baseURL,
        SUPABASE_URL_OVERRIDE: baseURL,
        SUPABASE_ANON_KEY_OVERRIDE: "fixture-anon-key",
        DOSU_TELEMETRY_DISABLED: "1",
        DO_NOT_TRACK: "1",
        NO_COLOR: "1",
        CI: "1",
      },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
    });
    child.on("error", reject);
    child.on("close", (status) => resolve({ status, stdout, stderr }));
  });
}

function calls(path: string): unknown[] {
  return requests.filter((r) => r.path === path).map((r) => r.input);
}

const READ_ONLY = new Set([
  "knowledgeStore.getBySpaceId",
  "libraries.info",
  "workspaces.get",
  "review.listPending",
]);

function expectNoWrites(configBefore: string) {
  for (const r of requests) {
    expect(r.method, r.path).toBe("GET");
    expect(READ_ONLY.has(r.path), r.path).toBe(true);
  }
  expect(readFileSync(configPath, "utf8")).toBe(configBefore);
}

describe("dosu review list (subprocess)", () => {
  it("lists Library A's mixed items and names the scope it searched", async () => {
    const before = selectLibrary(LIB_A, DEP_A);

    const human = await runCli();
    expect(human.status, human.stderr).toBe(0);
    expect(human.stdout).toMatch(new RegExp(`Library\\s+Library A \\(${LIB_A}\\)`));
    expect(human.stdout).toMatch(
      new RegExp(`MCP deployment\\s+Library A MCP Server \\(${DEP_A}\\)`),
    );
    expect(human.stdout).toContain("Deploying the Widget Service");
    expect(human.stdout).toContain("draft_message:aaaaaaaa-0000-4000-8000-00000000000d");
    expect(human.stdout).not.toContain("Billing FAQ");

    const json = await runCli("--json");
    expect(json.status, json.stderr).toBe(0);
    expect(json.stderr).toBe("");
    const out = JSON.parse(json.stdout);
    expect(out.items.map((i: Item) => i.kind)).toEqual([
      "doc_change",
      "draft_message",
      "doc_change",
    ]);
    expect(out.truncated).toBe(false);
    expect(out.total).toBe(3);
    expect(out.scope).toEqual({
      library: { id: LIB_A, name: "Library A" },
      deployment: { id: DEP_A, name: "Library A MCP Server" },
      kinds: ["doc_change", "draft_message"],
      since: null,
      until: null,
    });

    expect(calls("review.listPending")).toEqual([
      { knowledgeStoreId: KS_A, deploymentId: DEP_A },
      { knowledgeStoreId: KS_A, deploymentId: DEP_A },
    ]);
    expectNoWrites(before);
  });

  it("reports an empty Library A as empty in this scope, without reading Library B", async () => {
    world.docs[KS_A] = [];
    world.drafts[DEP_A] = [];
    const before = selectLibrary(LIB_A, DEP_A);

    const human = await runCli();
    expect(human.status, human.stderr).toBe(0);
    expect(human.stdout).toMatch(new RegExp(`Library\\s+Library A \\(${LIB_A}\\)`));
    expect(human.stdout).toContain("No pending review items in this scope.");
    expect(human.stdout).not.toContain("Library B");

    const json = await runCli("--json");
    const out = JSON.parse(json.stdout);
    expect(out).toMatchObject({ items: [], truncated: false, total: 0 });
    expect(out.scope.library.id).toBe(LIB_A);

    for (const input of calls("review.listPending")) {
      expect(input).toEqual({ knowledgeStoreId: KS_A, deploymentId: DEP_A });
    }
    expect(JSON.stringify(requests)).not.toContain(LIB_B);
    expect(JSON.stringify(requests)).not.toContain(DEP_B);
    expectNoWrites(before);
  });

  it("stops with a login error before any request when signed out", async () => {
    writeFileSync(configPath, '{"schema_version":2}\n');

    const res = await runCli("--json");

    expect(res.status).toBe(1);
    expect(res.stdout).toBe("");
    expect(res.stderr).toContain("Not logged in. Run 'dosu login' first.");
    expect(requests).toEqual([]);
  });

  it("names the missing Library and the selection commands when no target is saved", async () => {
    const before = writeTarget(undefined);

    const res = await runCli("--json");

    expect(res.status).toBe(1);
    expect(res.stdout).toBe("");
    expect(res.stderr).toContain("No Library selected.");
    expect(res.stderr).toContain("dosu deployments switch <deployment-id>");
    expect(res.stderr).not.toMatch(/space/i);
    expect(requests).toEqual([]);
    expectNoWrites(before);
  });

  it("fails on a stale (deleted) target instead of printing an empty queue", async () => {
    // The Library's knowledge store row still resolves; only the deployment is gone.
    world.stores[LIB_GONE] = "4444444d-4444-4444-8444-444444444444";
    const before = selectLibrary(LIB_GONE, DEP_GONE);

    const res = await runCli("--json");

    expect(res.status).toBe(1);
    expect(res.stdout).toBe("");
    expect(res.stderr).toContain(`The selected MCP deployment (${DEP_GONE}) is unavailable`);
    expect(res.stderr).toContain("dosu deployments list");
    expect(calls("review.listPending")).toEqual([]);
    expectNoWrites(before);
  });

  it("fails on a target the account cannot access, without a knowledge-store message", async () => {
    // Row-level security hides every row of another organization's Library.
    const before = selectLibrary(LIB_FOREIGN, DEP_FOREIGN);

    const res = await runCli();

    expect(res.status).toBe(1);
    expect(res.stdout).toBe("");
    expect(res.stderr).toContain("is unavailable");
    expect(res.stderr).toContain("dosu setup");
    expect(res.stderr).not.toContain("knowledge store");
    expect(calls("review.listPending")).toEqual([]);
    expectNoWrites(before);
  });

  it("prints IDs alone when optional names are unavailable", async () => {
    world.libraryInfoFails = true;
    world.deployments[DEP_A] = { ...mcp(DEP_A, "", LIB_A) };
    const before = writeTarget({
      org_id: ORG,
      space_id: LIB_A,
      deployment_id: DEP_A,
      library_name: "Cached From Elsewhere",
      deployment_name: "Cached Deployment",
    });

    const human = await runCli();
    expect(human.status, human.stderr).toBe(0);
    expect(human.stdout).toMatch(new RegExp(`Library\\s+${LIB_A}\\n`));
    expect(human.stdout).toMatch(new RegExp(`MCP deployment\\s+${DEP_A}\\n`));
    expect(human.stdout).not.toContain("Cached");

    const json = await runCli("--json");
    const out = JSON.parse(json.stdout);
    expect(out.scope.library).toEqual({ id: LIB_A, name: null });
    expect(out.scope.deployment).toEqual({ id: DEP_A, name: null });
    expectNoWrites(before);
  });

  it("lists doc changes only when no MCP deployment is saved (draft scope split)", async () => {
    const before = selectLibrary(LIB_A);

    const json = await runCli("--json");
    expect(json.status, json.stderr).toBe(0);
    const out = JSON.parse(json.stdout);
    expect(out.items.map((i: Item) => i.kind)).toEqual(["doc_change", "doc_change"]);
    expect(out.scope.deployment).toBeNull();
    expect(out.scope.kinds).toEqual(["doc_change"]);
    expect(calls("workspaces.get")).toEqual([]);
    expect(calls("review.listPending")).toEqual([{ knowledgeStoreId: KS_A }]);

    const human = await runCli();
    expect(human.stdout).toMatch(/MCP deployment\s+none selected \(draft replies not listed\)/);
    expectNoWrites(before);
  });

  it("sends the time range and records it in the scope", async () => {
    const before = selectLibrary(LIB_A, DEP_A);

    const json = await runCli("--since", "24h", "--json");
    expect(json.status, json.stderr).toBe(0);
    const out = JSON.parse(json.stdout);
    expect(out.items.map((i: Item) => i.title)).toEqual([
      "Deploying the Widget Service",
      "Rotate the widget API key",
    ]);
    const [sent] = calls("review.listPending") as Array<{ since: string }>;
    expect(sent).toMatchObject({ knowledgeStoreId: KS_A, deploymentId: DEP_A });
    expect(Math.abs(Date.parse(sent.since) - (Date.now() - 24 * HOUR))).toBeLessThan(60_000);
    expect(out.scope.since).toBe(sent.since);
    expect(out.scope.until).toBeNull();
    expectNoWrites(before);
  });

  it("keeps the truncated envelope and footer for a capped page", async () => {
    world.docs[KS_A] = Array.from({ length: 72 }, (_, n) =>
      doc(`aaaaaaaa-0000-4000-8000-${String(n).padStart(12, "0")}`, `Doc ${n}`, (n + 10) * HOUR),
    );
    const before = selectLibrary(LIB_A, DEP_A);

    const json = await runCli("--json");
    const out = JSON.parse(json.stdout);
    expect(out.items).toHaveLength(50);
    expect(out.truncated).toBe(true);
    expect(out.total).toBe(73);

    const human = await runCli();
    expect(human.stdout).toContain("Showing 50 of 73+ pending items (list truncated).");
    expectNoWrites(before);
  });
});
