/**
 * Failure telemetry and stderr diagnostics through the real CLI entry (`bun run src/index.ts`).
 *
 * One local HTTPS server plays three roles: the Dosu web app's `/api/cli-trpc` fixture, the
 * PostHog proxy (`/ph-api/i/v0/e/`), and the Sentry envelope endpoint. Command telemetry only
 * sends to HTTPS, so the server uses a throwaway self-signed certificate that the child trusts
 * through NODE_EXTRA_CA_CERTS. Each child runs with its own temporary HOME, so nothing touches a
 * real config, and the assertions cover exactly what crossed the wire.
 */

import { execFileSync, spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import type { IncomingMessage, ServerResponse } from "node:http";
import { createServer, type Server } from "node:https";
import {
  type AddressInfo,
  createServer as createTcpServer,
  type Server as TcpServer,
} from "node:net";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import superjson from "superjson";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";

const ENTRY = resolve(__dirname, "..", "index.ts");

const ORG = "11111111-1111-4111-8111-111111111111";
const LIB_A = "2222222a-2222-4222-8222-222222222222";
const DEP_A = "3333333a-3333-4333-8333-333333333333";
const DEP_A2 = "3333333a-9999-4333-8333-333333333333";
const DEP_GONE = "3333333d-3333-4333-8333-333333333333";
const KS_A = "4444444a-4444-4444-8444-444444444444";
const DOC_A = "aaaaaaaa-0000-4000-8000-000000000001";
const MISSING_ITEM = "aaaaaaaa-dead-4000-8000-000000000404";

/** Values that must never leave the machine in a telemetry payload. */
const REQUEST_ID = "iad1::sentinel-req-7f3a9c";
const SERVER_MESSAGE = "sentinel server message 5d1e";
const BAD_PREFIX = "zzsentinelarg";
const ACCESS_TOKEN = "sentinel-access-token-8b2c";
const API_KEY = "sentinel-api-key-41aa";
const PROTECTED = [
  REQUEST_ID,
  "sentinel-req",
  SERVER_MESSAGE,
  BAD_PREFIX,
  ACCESS_TOKEN,
  API_KEY,
  LIB_A,
  DEP_A,
  DEP_A2,
  DEP_GONE,
  KS_A,
  DOC_A,
  MISSING_ITEM,
  "Not logged in",
  "unavailable",
  "No Library selected",
  "Ambiguous",
  "review.listPending",
  "--json",
  "--confirm",
];

interface Recorded {
  method: string;
  path: string;
  input: unknown;
  body: string;
}

type Route = (path: string, input: unknown) => { data: unknown } | { error: TrpcFailure };

interface TrpcFailure {
  code: string;
  httpStatus: number;
  message?: string;
  requestId?: unknown;
}

let certDir = "";
let server: Server;
let baseURL = "";
let sentryDsn = "";
let requests: Recorded[] = [];
let route: Route = defaultRoute;

function deployment(id: string, name: string) {
  return {
    deployment_id: id,
    name,
    space_id: LIB_A,
    org_id: ORG,
    provider_slug: "dosu_mcp",
    enabled: true,
  };
}

function defaultRoute(path: string, input: unknown): { data: unknown } | { error: TrpcFailure } {
  switch (path) {
    case "knowledgeStore.getBySpaceId":
      return {
        data:
          (input as { space_id: string }).space_id === LIB_A
            ? { id: KS_A, space_id: LIB_A, org_id: ORG }
            : null,
      };
    case "libraries.info":
      return input === LIB_A
        ? { data: { id: LIB_A, name: "Library A", org_id: ORG, deleted_at: null } }
        : { error: { code: "NOT_FOUND", httpStatus: 404 } };
    case "workspaces.get":
      return { data: input === DEP_A ? deployment(DEP_A, "Library A MCP Server") : null };
    case "workspaces.listForOrg":
      return {
        data: [
          deployment(DEP_A, "Library A MCP Server"),
          deployment(DEP_A2, "Library A Second MCP"),
        ],
      };
    case "review.listPending":
      return {
        data: {
          items: [
            {
              id: DOC_A,
              kind: "doc_change",
              pageId: "page-1",
              title: "Deploying the Widget Service",
              version: 2,
              type: "document",
              origin: "llm_generated",
              source: "AI generated",
              externalTriggerUrl: null,
              pendingStatus: "PENDING_REVIEW",
              createdAt: new Date().toISOString(),
            },
          ],
          truncated: false,
          total: 1,
        },
      };
    case "review.getChange":
      return { error: { code: "NOT_FOUND", httpStatus: 404 } };
    default:
      return { error: { code: "NOT_FOUND", httpStatus: 404 } };
  }
}

function sendTrpcError(res: ServerResponse, path: string, failure: TrpcFailure): void {
  res.writeHead(failure.httpStatus, { "content-type": "application/json" });
  res.end(
    JSON.stringify({
      error: superjson.serialize({
        message: failure.message ?? "Not found",
        code: failure.httpStatus === 404 ? -32004 : -32603,
        data: {
          code: failure.code,
          httpStatus: failure.httpStatus,
          path,
          ...(failure.requestId === undefined ? {} : { requestId: failure.requestId }),
        },
      }),
    }),
  );
}

function handle(req: IncomingMessage, res: ServerResponse): void {
  const url = new URL(req.url ?? "/", "https://fixture");
  let body = "";
  // A child that gives up on a slow delivery resets its socket; that is not a test failure.
  req.on("error", () => {});
  res.on("error", () => {});
  req.setEncoding("utf8");
  req.on("data", (chunk: string) => {
    body += chunk;
  });
  req.on("end", () => {
    const method = req.method ?? "";
    if (url.pathname.startsWith("/api/cli-trpc/")) {
      const path = url.pathname.replace(/^\/api\/cli-trpc\//, "");
      const raw = url.searchParams.get("input");
      const input = raw ? superjson.deserialize(JSON.parse(raw)) : undefined;
      requests.push({ method, path, input, body });
      const result = method === "GET" ? route(path, input) : undefined;
      if (!result || "error" in result) {
        sendTrpcError(
          res,
          path,
          result?.error ?? { code: "METHOD_NOT_SUPPORTED", httpStatus: 405 },
        );
        return;
      }
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ result: { data: superjson.serialize(result.data) } }));
      return;
    }
    requests.push({ method, path: url.pathname, input: undefined, body });
    res.writeHead(url.pathname.startsWith("/ph-api/") ? 200 : 404, {
      "content-type": "application/json",
    });
    res.end("{}");
  });
}

beforeAll(async () => {
  certDir = mkdtempSync(join(tmpdir(), "dosu-telemetry-cert-"));
  execFileSync(
    "openssl",
    [
      "req",
      "-x509",
      "-newkey",
      "ec",
      "-pkeyopt",
      "ec_paramgen_curve:prime256v1",
      "-nodes",
      "-keyout",
      join(certDir, "key.pem"),
      "-out",
      join(certDir, "cert.pem"),
      "-days",
      "1",
      "-subj",
      "/CN=127.0.0.1",
      "-addext",
      "subjectAltName=IP:127.0.0.1",
    ],
    { stdio: "ignore" },
  );
  server = createServer(
    {
      key: readFileSync(join(certDir, "key.pem")),
      cert: readFileSync(join(certDir, "cert.pem")),
    },
    handle,
  );
  await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
  const { port } = server.address() as AddressInfo;
  baseURL = `https://127.0.0.1:${port}`;
  sentryDsn = `https://fixturepublickey@127.0.0.1:${port}/42`;
});

afterAll(async () => {
  await new Promise<void>((done) => server.close(() => done()));
  rmSync(certDir, { recursive: true, force: true });
});

let home = "";
let configDir = "";
let configPath = "";

beforeEach(() => {
  requests = [];
  route = defaultRoute;
  home = mkdtempSync(join(tmpdir(), "dosu-failure-telemetry-"));
  configDir = join(home, ".config", "dosu-cli");
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

function writeConfig(target?: Record<string, string>): string {
  const text = `${JSON.stringify(
    {
      schema_version: 2,
      active_account: {
        user_id: "e2e-user",
        session: { access_token: ACCESS_TOKEN, refresh_token: "r", expires_at: 0 },
        ...(target ? { target } : {}),
      },
    },
    null,
    2,
  )}\n`;
  writeFileSync(configPath, text);
  return text;
}

function selectLibraryA(deploymentId: string = DEP_A): string {
  return writeConfig({
    org_id: ORG,
    space_id: LIB_A,
    deployment_id: deploymentId,
    api_key: API_KEY,
  });
}

interface RunResult {
  status: number | null;
  stdout: string;
  stderr: string;
  elapsedMs: number;
}

function runCli(args: string[], env: Record<string, string> = {}): Promise<RunResult> {
  const startedAt = Date.now();
  return new Promise((done, reject) => {
    const child = spawn("bun", ["run", ENTRY, ...args], {
      // A scratch cwd: no repo .env autoload and nothing written next to the sources.
      cwd: home,
      env: {
        PATH: process.env.PATH ?? "",
        HOME: home,
        XDG_CONFIG_HOME: join(home, ".config"),
        CLAUDE_CONFIG_DIR: join(home, ".claude"),
        NODE_ENV: "test",
        NODE_EXTRA_CA_CERTS: join(certDir, "cert.pem"),
        DOSU_DEV: "false",
        DOSU_WEB_APP_URL_OVERRIDE: baseURL,
        DOSU_BACKEND_URL_OVERRIDE: baseURL,
        SUPABASE_URL_OVERRIDE: baseURL,
        SUPABASE_ANON_KEY_OVERRIDE: "fixture-anon-key",
        DOSU_POSTHOG_PROJECT_TOKEN_OVERRIDE: "phc_fixture_project_token",
        DOSU_CLI_SENTRY_DSN_OVERRIDE: sentryDsn,
        NO_COLOR: "1",
        CI: "1",
        ...env,
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
    child.on("close", (status) =>
      done({ status, stdout, stderr, elapsedMs: Date.now() - startedAt }),
    );
  });
}

interface CommandEvent {
  event: string;
  distinct_id: string;
  properties: Record<string, unknown>;
}

function analyticsBodies(): string[] {
  return requests.filter((r) => r.path === "/ph-api/i/v0/e/").map((r) => r.body);
}

function sentryBodies(): string[] {
  return requests.filter((r) => r.path === "/api/42/envelope/").map((r) => r.body);
}

function trpcCalls(path?: string): Recorded[] {
  return requests.filter((r) => !r.path.startsWith("/") && (path === undefined || r.path === path));
}

/** Exactly one completion event reached the collector; return it. */
function onlyEvent(): CommandEvent {
  const bodies = analyticsBodies();
  expect(bodies).toHaveLength(1);
  return JSON.parse(bodies[0] ?? "{}") as CommandEvent;
}

function expectNoProtectedValues(): void {
  for (const body of [...analyticsBodies(), ...sentryBodies()]) {
    for (const value of PROTECTED) expect(body).not.toContain(value);
  }
}

function expectFailureEvent(command: string, errorCode: string): CommandEvent {
  const event = onlyEvent();
  expect(event.event).toBe("cli_command_completed");
  expect(event.properties).toMatchObject({
    command,
    result: "failure",
    exit_code: 1,
    error_code: errorCode,
  });
  expectNoProtectedValues();
  return event;
}

describe("failure telemetry (subprocess)", () => {
  it("records a signed-out review list as one NOT_LOGGED_IN failure", async () => {
    writeFileSync(configPath, '{"schema_version":2}\n');

    const res = await runCli(["review", "list", "--json"]);

    expect(res.status).toBe(1);
    expect(res.stdout).toBe("");
    expect(res.stderr).toContain("Not logged in. Run 'dosu login' first.");
    expect(trpcCalls()).toEqual([]);
    expectFailureEvent("review list", "NOT_LOGGED_IN");
    // Expected account states are analytics, not crash reports.
    expect(sentryBodies()).toEqual([]);
  });

  it("records a missing Library as one NO_LIBRARY_SELECTED failure", async () => {
    writeConfig(undefined);

    const res = await runCli(["review", "list", "--json"]);

    expect(res.status).toBe(1);
    expect(res.stdout).toBe("");
    expect(res.stderr).toContain("No Library selected.");
    expect(res.stderr).toContain("dosu deployments switch <deployment-id>");
    expect(trpcCalls()).toEqual([]);
    expectFailureEvent("review list", "NO_LIBRARY_SELECTED");
    expect(sentryBodies()).toEqual([]);
  });

  it("records an unavailable selected deployment without listing the queue", async () => {
    selectLibraryA(DEP_GONE);

    const res = await runCli(["review", "list", "--json"]);

    expect(res.status).toBe(1);
    expect(res.stdout).toBe("");
    expect(res.stderr).toContain(`The selected MCP deployment (${DEP_GONE}) is unavailable`);
    expect(trpcCalls("review.listPending")).toEqual([]);
    expectFailureEvent("review list", "DEPLOYMENT_UNAVAILABLE");
  });

  it("records an unknown deployment prefix and never mints an API key", async () => {
    const before = selectLibraryA();

    const res = await runCli(["deployments", "switch", BAD_PREFIX, "--json"]);

    expect(res.status).toBe(1);
    expect(res.stdout).toBe("");
    expect(res.stderr).toContain(`Deployment not found: ${BAD_PREFIX}`);
    expect(trpcCalls().map((r) => r.path)).toEqual(["workspaces.listForOrg"]);
    expect(requests.some((r) => r.method !== "GET" && !r.path.startsWith("/ph-api/"))).toBe(false);
    expect(readFileSync(configPath, "utf8")).toBe(before);
    expectFailureEvent("deployments switch", "DEPLOYMENT_NOT_FOUND");
  });

  it("records an ambiguous deployment prefix and lists the candidates on stderr", async () => {
    const before = selectLibraryA();

    const res = await runCli(["deployments", "switch", "3333333a"]);

    expect(res.status).toBe(1);
    expect(res.stdout).toBe("");
    expect(res.stderr).toContain("Ambiguous deployment ID prefix: 3333333a matches 2:");
    expect(res.stderr).toContain(DEP_A);
    expect(res.stderr).toContain(DEP_A2);
    expect(trpcCalls("workspaces.get")).toEqual([]);
    expect(readFileSync(configPath, "utf8")).toBe(before);
    expectFailureEvent("deployments switch", "DEPLOYMENT_AMBIGUOUS");
  });

  it("stops approve on an unknown item before any publication mutation", async () => {
    selectLibraryA();

    const res = await runCli(["review", "approve", MISSING_ITEM, "--confirm", "--json"]);

    expect(res.status).toBe(1);
    expect(res.stdout).toBe("");
    expect(res.stderr).toContain(`No review item found for '${MISSING_ITEM}'.`);
    expect(trpcCalls().map((r) => r.path)).toEqual(["review.getChange"]);
    expectFailureEvent("review approve", "REVIEW_ITEM_NOT_FOUND");
  });

  it("prints a thrown tRPC error's request ID on stderr but never sends it", async () => {
    selectLibraryA();
    route = (path, input) =>
      path === "review.listPending"
        ? {
            error: {
              code: "INTERNAL_SERVER_ERROR",
              httpStatus: 500,
              message: SERVER_MESSAGE,
              requestId: REQUEST_ID,
            },
          }
        : defaultRoute(path, input);

    const res = await runCli(["review", "list", "--json"]);

    expect(res.status).toBe(1);
    expect(res.stdout).toBe("");
    expect(res.stderr).toContain(SERVER_MESSAGE);
    expect(res.stderr).toContain(
      `code=INTERNAL_SERVER_ERROR path=review.listPending status=500 request_id=${REQUEST_ID}`,
    );
    expectFailureEvent("review list", "INTERNAL_SERVER_ERROR");
    // A thrown server failure is a crash report; it carries the code, not the request ID.
    expect(sentryBodies()).toHaveLength(1);
    expect(sentryBodies()[0]).toContain('"error_code":"INTERNAL_SERVER_ERROR"');
  });

  it("omits a malformed request ID but keeps the code, path, and status", async () => {
    selectLibraryA();
    route = (path, input) =>
      path === "review.listPending"
        ? {
            error: {
              code: "INTERNAL_SERVER_ERROR",
              httpStatus: 500,
              requestId: "\u001b[2Jsentinel-req\nforged: line",
            },
          }
        : defaultRoute(path, input);

    const res = await runCli(["review", "list", "--json"]);

    expect(res.status).toBe(1);
    expect(res.stderr).toContain("code=INTERNAL_SERVER_ERROR path=review.listPending status=500");
    expect(res.stderr).not.toContain("request_id=");
    expect(res.stderr).not.toContain("sentinel-req");
    expect(res.stderr).not.toContain("\u001b[2J");
    expectFailureEvent("review list", "INTERNAL_SERVER_ERROR");
  });

  it("keeps a successful list at exit 0 with valid JSON and one success event", async () => {
    selectLibraryA();

    const res = await runCli(["review", "list", "--json"]);

    expect(res.status, res.stderr).toBe(0);
    expect(res.stderr).toBe("");
    const out = JSON.parse(res.stdout) as { items: Array<{ id: string }>; total: number };
    expect(out.items.map((item) => item.id)).toEqual([DOC_A]);
    const event = onlyEvent();
    expect(event.properties).toMatchObject({ command: "review list", result: "success" });
    expect(event.properties.exit_code).toBe(0);
    expect(event.properties).not.toHaveProperty("error_code");
    expect(sentryBodies()).toEqual([]);
    expectNoProtectedValues();

    requests = [];
    const deployments = await runCli(["deployments", "list", "--json"]);
    expect(deployments.status, deployments.stderr).toBe(0);
    expect(JSON.parse(deployments.stdout)).toHaveLength(2);
    expect(onlyEvent().properties).toMatchObject({
      command: "deployments list",
      result: "success",
    });
  });

  it.each([
    ["DO_NOT_TRACK"],
    ["DOSU_TELEMETRY_DISABLED"],
  ])("sends nothing and creates no installation ID when %s is set", async (variable) => {
    writeFileSync(configPath, '{"schema_version":2}\n');

    const res = await runCli(["review", "list", "--json"], { [variable]: "1" });

    expect(res.status).toBe(1);
    expect(res.stderr).toContain("Not logged in.");
    expect(requests).toEqual([]);
    expect(existsSync(join(configDir, "telemetry.json"))).toBe(false);
  });
});

describe("failure telemetry with an unreachable collector (subprocess)", () => {
  let blackhole: TcpServer;
  let blackholeURL = "";
  const sockets = new Set<import("node:net").Socket>();

  beforeAll(async () => {
    // Accepts TCP and then never answers the TLS handshake.
    blackhole = createTcpServer((socket) => {
      sockets.add(socket);
      socket.on("close", () => sockets.delete(socket));
      // The child aborts its hung handshake at the deadline; that reset is the expected outcome.
      socket.on("error", () => {});
    });
    await new Promise<void>((done) => blackhole.listen(0, "127.0.0.1", done));
    blackholeURL = `https://127.0.0.1:${(blackhole.address() as AddressInfo).port}`;
  });

  afterAll(async () => {
    for (const socket of sockets) socket.destroy();
    await new Promise<void>((done) => blackhole.close(() => done()));
  });

  it("keeps the failure output and exit code and stays within the flush bound", async () => {
    writeFileSync(configPath, '{"schema_version":2}\n');

    const res = await runCli(["review", "list", "--json"], {
      DOSU_WEB_APP_URL_OVERRIDE: blackholeURL,
      DOSU_CLI_SENTRY_DSN_OVERRIDE: `https://fixturepublickey@${new URL(blackholeURL).host}/42`,
    });

    expect(res.status).toBe(1);
    expect(res.stdout).toBe("");
    expect(res.stderr).toBe("Not logged in. Run 'dosu login' first.\n");
    // 750ms flush cap plus process startup; a hung collector must not hold the CLI.
    expect(res.elapsedMs).toBeLessThan(6_000);
  });

  it("fails open when nothing listens on the collector port", async () => {
    writeFileSync(configPath, '{"schema_version":2}\n');

    const res = await runCli(["review", "list", "--json"], {
      DOSU_WEB_APP_URL_OVERRIDE: "https://127.0.0.1:1",
    });

    expect(res.status).toBe(1);
    expect(res.stdout).toBe("");
    expect(res.stderr).toBe("Not logged in. Run 'dosu login' first.\n");
  });
});
