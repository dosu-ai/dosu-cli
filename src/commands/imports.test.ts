/** `dosu imports connect|status|sync|disconnect` against a faked `/v1/memory/imports`: what
 * each sends and prints. */

import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { saveConfig } from "../config/config";
import { makeTestConfig } from "../config/config.test-utils";
import type { ImportStatus } from "../sources/api";
import { confirm } from "../tui/prompts";
import { importsCommand } from "./imports";

vi.mock("../tui/prompts", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../tui/prompts")>()),
  confirm: vi.fn(),
}));

let home: string;
type Fetch = (input: string, init?: RequestInit) => Promise<Response>;
let fetchImpl: ReturnType<typeof vi.fn<Fetch>>;
let out: string[];

function imported(extra: Partial<ImportStatus> = {}): ImportStatus {
  return {
    id: "22222222-2222-4222-8222-222222222222",
    name: "acme datadog",
    org: "org1",
    deployment_id: "dep1",
    source_id: "33333333-3333-4333-8333-333333333333",
    agent: "datadog-trajectory",
    kind: "s3",
    bucket: "acme-trajectories",
    prefix: "sessions",
    url: "s3://acme-trajectories/sessions",
    region: "us-east-1",
    account_id: null,
    endpoint: null,
    shards: 1,
    dated_prefix: "sessions/",
    lookback_days: 3,
    enabled: true,
    last_imported_at: null,
    last_error: null,
    error_count: 0,
    last_run_listed: 0,
    last_run_imported: 0,
    last_run_remaining: 0,
    created_at: "2026-11-03T00:00:00.000Z",
    files: 0,
    sessions: 0,
    files_found: 2,
    ...extra,
  };
}

function configure(loggedIn = true): void {
  saveConfig(
    makeTestConfig({
      access_token: "t",
      refresh_token: "r",
      expires_at: 0,
      ...(loggedIn ? { api_key: "sk_test", deployment_id: "dep1", org_id: "org1" } : {}),
    }),
  );
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status });
}

function calls(): Array<{ method: string; path: string; body?: unknown }> {
  return fetchImpl.mock.calls.map(([url, init]) => ({
    method: init?.method ?? "GET",
    path: url.replace("https://api.dosu.test", ""),
    ...(init?.body ? { body: JSON.parse(init.body as string) } : {}),
  }));
}

beforeEach(() => {
  home = realpathSync(mkdtempSync(join(tmpdir(), "dosu-imports-")));
  vi.stubEnv("HOME", home);
  vi.stubEnv("XDG_CONFIG_HOME", join(home, ".config"));
  vi.stubEnv("DOSU_DEV", undefined);
  vi.stubEnv("DOSU_BACKEND_URL_OVERRIDE", "https://api.dosu.test");
  vi.stubEnv("DOSU_SOURCE_ACCESS_KEY_ID", undefined);
  vi.stubEnv("DOSU_SOURCE_SECRET_ACCESS_KEY", undefined);
  vi.mocked(confirm).mockReset();
  fetchImpl = vi.fn<Fetch>(async () => json({ imports: [] }));
  vi.stubGlobal("fetch", fetchImpl);
  out = [];
  vi.spyOn(console, "log").mockImplementation((...args: unknown[]) => {
    out.push(args.join(" "));
  });
  configure();
});

afterEach(() => {
  process.exitCode = undefined;
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  rmSync(home, { recursive: true, force: true });
});

async function dosu(...args: string[]): Promise<void> {
  const cmd = importsCommand();
  cmd.exitOverride();
  await cmd.parseAsync(["node", "dosu", ...args]);
}

describe("dosu imports connect", () => {
  it("posts the bucket, format and keys, and prints what Dosu found", async () => {
    fetchImpl.mockImplementation(async () => json(imported()));
    await dosu(
      "connect",
      "--agent",
      "datadog-trajectory",
      "--bucket",
      "acme-trajectories",
      "--prefix",
      "/sessions/",
      "--region",
      "us-east-1",
      "--access-key-id",
      "AKIA",
      "--secret-access-key",
      "shh",
      "--shards",
      "4",
      "--name",
      "acme datadog",
    );
    expect(calls()).toEqual([
      {
        method: "POST",
        path: "/v1/memory/imports",
        body: {
          deployment_id: "dep1",
          agent: "datadog-trajectory",
          kind: "s3",
          bucket: "acme-trajectories",
          prefix: "sessions",
          region: "us-east-1",
          access_key_id: "AKIA",
          secret_access_key: "shh",
          name: "acme datadog",
          shards: 4,
        },
      },
    ]);
    expect(out.join("\n")).toContain("2 datadog-trajectory files on the first page");
    expect(out.join("\n")).toContain("laid out by day under sessions/");
    expect(out.join("\n")).toContain('Import "acme datadog" connected');
  });

  it("refuses a format the SDK does not read before calling Dosu", async () => {
    await expect(
      dosu(
        "connect",
        "--agent",
        "copilot",
        "--bucket",
        "b",
        "--access-key-id",
        "a",
        "--secret-access-key",
        "s",
      ),
    ).rejects.toThrow(/--agent must be one of/);
    expect(calls()).toEqual([]);
  });

  it("turns Dosu's 422 into a usage error naming the bucket", async () => {
    fetchImpl.mockImplementation(async () => json({ detail: "AccessDenied" }, 422));
    await expect(
      dosu(
        "connect",
        "--agent",
        "claude-code",
        "--bucket",
        "b",
        "--access-key-id",
        "a",
        "--secret-access-key",
        "s",
      ),
    ).rejects.toThrow(/could not import s3:\/\/b with the flags keys: HTTP 422: AccessDenied/);
  });

  it("needs a login", async () => {
    configure(false);
    await expect(
      dosu(
        "connect",
        "--agent",
        "claude-code",
        "--bucket",
        "b",
        "--access-key-id",
        "a",
        "--secret-access-key",
        "s",
      ),
    ).rejects.toThrow(/not logged in/);
  });
});

describe("dosu imports status / sync / disconnect", () => {
  it("lists every import with --all", async () => {
    fetchImpl.mockImplementation(async () => json({ imports: [imported({ sessions: 7 })] }));
    await dosu("status", "--all");
    expect(calls()).toEqual([{ method: "GET", path: "/v1/memory/imports?deployment_id=dep1" }]);
    expect(out.join("\n")).toContain("acme datadog");
    expect(out.join("\n")).toContain("datadog-trajectory");
  });

  it("shows the only import without a selector, with its recent files", async () => {
    fetchImpl.mockImplementation(async (url) =>
      url.endsWith("?deployment_id=dep1")
        ? json({ imports: [imported()] })
        : json(
            imported({
              files: 2,
              sessions: 2,
              last_imported_at: "2026-11-03T00:00:00.000Z",
              last_run_listed: 2,
              last_run_imported: 2,
              recent: [
                {
                  key: "sessions/2026-11-03/session-a.jsonl",
                  session_id: "session-a",
                  size: 10,
                  shipped_bytes: 10,
                  outcome: "stored",
                  detail: null,
                  content_hash: "abc",
                  imported_at: "2026-11-03T00:00:00.000Z",
                },
              ],
            }),
          ),
    );
    await dosu("status");
    const text = out.join("\n");
    expect(text).toContain("2 sessions from 2 files");
    expect(text).toContain("2 listed, 2 imported");
    expect(text).toContain("stored");
    expect(text).toContain("sessions/2026-11-03/session-a.jsonl");
  });

  it("queues a run and says how many shards", async () => {
    fetchImpl.mockImplementation(async (_url, init) =>
      init?.method === "POST"
        ? json({ id: imported().id, status: "queued", workflow_ids: ["a", "b"] })
        : json({ imports: [imported({ shards: 2 })] }),
    );
    await dosu("sync");
    expect(calls()[1]).toEqual({
      method: "POST",
      path: `/v1/memory/imports/${imported().id}/sync`,
    });
    expect(out.join("\n")).toContain("2 shards");
  });

  it("asks which import when there are several", async () => {
    fetchImpl.mockImplementation(async (_url, init) =>
      init?.method === "POST"
        ? json({
            id: "44444444-4444-4444-8444-444444444444",
            status: "queued",
            workflow_ids: ["a"],
          })
        : json({
            imports: [
              imported(),
              imported({ id: "44444444-4444-4444-8444-444444444444", name: "other" }),
            ],
          }),
    );
    await expect(dosu("sync")).rejects.toThrow(/2 imports connected; say which with --import/);
    await dosu("sync", "--import", "other");
    expect(calls().at(-1)?.path).toBe(
      "/v1/memory/imports/44444444-4444-4444-8444-444444444444/sync",
    );
  });

  it("disconnects with --yes", async () => {
    fetchImpl.mockImplementation(async (_url, init) =>
      init?.method === "DELETE"
        ? new Response(null, { status: 204 })
        : json({ imports: [imported()] }),
    );
    await dosu("disconnect", "--yes");
    expect(calls()[1]).toEqual({ method: "DELETE", path: `/v1/memory/imports/${imported().id}` });
    expect(out.join("\n")).toContain('"acme datadog" disconnected');
  });
});

/** `connect` with a bucket and keys, plus whatever else a test adds. */
function connectArgs(...extra: string[]): string[] {
  return [
    "connect",
    "--agent",
    "claude-code",
    "--bucket",
    "b",
    "--access-key-id",
    "a",
    "--secret-access-key",
    "s",
    ...extra,
  ];
}

describe("dosu imports connect, the rest of it", () => {
  it.each([
    [["--kind", "gcs"], /--kind must be s3 or r2, got 'gcs'/],
    [["--kind", "r2"], /an r2 bucket needs --account-id or --endpoint/],
    [["--shards", "0"], /--shards must be a whole number from 1 to 64, got '0'/],
    [["--shards", "many"], /--shards must be a whole number from 1 to 64/],
    [["--lookback-days", "4000"], /--lookback-days must be a whole number from 1 to 3650/],
  ])("refuses %j before calling Dosu", async (extra, message) => {
    await expect(dosu(...connectArgs(...extra))).rejects.toThrow(message);
    expect(calls()).toEqual([]);
  });

  it("sends an r2 bucket's account, endpoint and lookback", async () => {
    fetchImpl.mockImplementation(async () =>
      json(imported({ kind: "r2", shards: 2, dated_prefix: null, files_found: null })),
    );
    await dosu(
      ...connectArgs(
        "--kind",
        "r2",
        "--account-id",
        "acct",
        "--endpoint",
        "https://r2.example.com",
        "--lookback-days",
        "7",
      ),
    );
    expect(calls()[0]?.body).toMatchObject({
      kind: "r2",
      account_id: "acct",
      endpoint: "https://r2.example.com",
      lookback_days: 7,
    });
    const text = out.join("\n");
    expect(text).toContain("0 datadog-trajectory files on the first page.");
    expect(text).not.toContain("laid out by day");
    expect(text).toContain("2 shards");
  });

  it("says file, not files, when Dosu found one", async () => {
    fetchImpl.mockImplementation(async () =>
      json(imported({ agent: "claude-code", files_found: 1 })),
    );
    await dosu(...connectArgs());
    expect(out.join("\n")).toContain("1 claude-code file on the first page");
  });

  it("prints Dosu's answer as JSON with --json", async () => {
    fetchImpl.mockImplementation(async () => json(imported()));
    await dosu(...connectArgs("--json"));
    expect(JSON.parse(out.join("\n"))).toMatchObject({ id: imported().id });
  });

  it.each([
    [400, { detail: "NoSuchBucket" }, /could not import s3:\/\/b with the flags keys: HTTP 400/],
    [409, { detail: "exists" }, /s3:\/\/b is already connected/],
    [404, {}, /https:\/\/api\.dosu\.test does not import session stores: HTTP 404/],
  ])("turns Dosu's %i into a usage error", async (status, body, message) => {
    fetchImpl.mockImplementation(async () => json(body, status));
    await expect(dosu(...connectArgs())).rejects.toThrow(message);
  });

  it("lets any other failure through as it is", async () => {
    fetchImpl.mockImplementation(async () => new Response("down", { status: 500 }));
    await expect(dosu(...connectArgs())).rejects.toThrow(/^HTTP 500$/);
  });
});

describe("dosu imports status, the rest of it", () => {
  it("says there is nothing to show when the org has no imports", async () => {
    await dosu("status", "--all");
    expect(out.join("\n")).toContain("No imports connected.");
  });

  it("lists every import as JSON, each one's state named", async () => {
    fetchImpl.mockImplementation(async () =>
      json({ imports: [imported(), imported({ enabled: false })] }),
    );
    await dosu("status", "--all", "--json");
    expect(JSON.parse(out.join("\n")).imports).toHaveLength(2);
  });

  it("names each import's state in the table", async () => {
    fetchImpl.mockImplementation(async () =>
      json({
        imports: [
          imported({ name: "off", enabled: false }),
          imported({ name: "broken", last_error: "AccessDenied", error_count: 3 }),
          imported({ name: "fine", last_imported_at: "2026-11-03T00:00:00.000Z" }),
        ],
      }),
    );
    await dosu("status", "--all");
    const text = out.join("\n");
    expect(text).toContain("disabled");
    expect(text).toContain("error ×3");
    expect(text).toContain("ok");
  });

  it("shows one import as JSON with --json", async () => {
    fetchImpl.mockImplementation(async (url) =>
      url.endsWith("?deployment_id=dep1") ? json({ imports: [imported()] }) : json(imported()),
    );
    await dosu("status", "--json");
    expect(JSON.parse(out.join("\n"))).toMatchObject({ id: imported().id });
  });

  it("shows a disabled import's last error and a failed file's detail", async () => {
    const broken = imported({
      enabled: false,
      files: 1,
      sessions: 1,
      shards: 1,
      dated_prefix: null,
      last_error: "AccessDenied",
      error_count: 2,
      last_run_remaining: 1,
      recent: [
        {
          key: "sessions/bad.jsonl",
          session_id: "bad",
          size: 1,
          shipped_bytes: 0,
          outcome: "rejected",
          detail: "not a claude-code transcript",
          content_hash: null,
          imported_at: "2026-11-03T00:00:00.000Z",
        },
      ],
    });
    fetchImpl.mockImplementation(async (url) =>
      url.endsWith("?deployment_id=dep1") ? json({ imports: [broken] }) : json(broken),
    );
    await dosu("status");
    const text = out.join("\n");
    expect(text).toContain("1 session from 1 file");
    expect(text).toContain("Last run:   not yet");
    expect(text).toContain("1 file · 1 shard");
    expect(text).toContain("Disabled by Dosu");
    expect(text).toContain("Last error: AccessDenied (2 in a row)");
    expect(text).toContain("not a claude-code transcript");
  });

  it("shows an enabled import that is erroring, sharded, with no recent files", async () => {
    const erroring = imported({
      shards: 3,
      last_error: "SlowDown",
      error_count: 1,
      last_run_remaining: 5,
    });
    fetchImpl.mockImplementation(async (url) =>
      url.endsWith("?deployment_id=dep1") ? json({ imports: [erroring] }) : json(erroring),
    );
    await dosu("status");
    const text = out.join("\n");
    expect(text).toContain("5 files · 3 shards · last 3 days of sessions/");
    expect(text).toContain("Last error: SlowDown (1 in a row)");
    expect(text).not.toContain("Disabled by Dosu");
    expect(text).not.toContain("Recent:");
  });

  it("says which import it could not find, or that there are none", async () => {
    fetchImpl.mockImplementation(async () => json({ imports: [imported()] }));
    await expect(dosu("status", "--import", "nope")).rejects.toThrow(/no import 'nope'/);
    fetchImpl.mockImplementation(async () => json({ imports: [] }));
    await expect(dosu("status")).rejects.toThrow(/no imports connected/);
  });
});

describe("dosu imports sync and disconnect, the rest of it", () => {
  function oneImport(): void {
    fetchImpl.mockImplementation(async (_url, init) => {
      if (init?.method === "POST") {
        return json({ id: imported().id, status: "queued", workflow_ids: ["a"] });
      }
      if (init?.method === "DELETE") return new Response(null, { status: 204 });
      return json({ imports: [imported()] });
    });
  }

  it("prints the queued run as JSON with --json", async () => {
    oneImport();
    await dosu("sync", "--json");
    expect(JSON.parse(out.join("\n"))).toMatchObject({ workflow_ids: ["a"] });
  });

  it("says one shard for a one-shard run", async () => {
    oneImport();
    await dosu("sync");
    expect(out.join("\n")).toContain("1 shard;");
  });

  it("asks before disconnecting, and does nothing when the answer is no", async () => {
    oneImport();
    vi.mocked(confirm).mockResolvedValueOnce(false);
    await dosu("disconnect");
    expect(calls().map((c) => c.method)).toEqual(["GET"]);
    expect(out.join("\n")).toContain("Cancelled.");
  });

  it("disconnects once the user says yes", async () => {
    oneImport();
    vi.mocked(confirm).mockResolvedValueOnce(true);
    await dosu("disconnect");
    expect(calls().at(-1)?.method).toBe("DELETE");
  });

  it("will not disconnect from --json without --yes, and prints JSON with both", async () => {
    oneImport();
    await expect(dosu("disconnect", "--json")).rejects.toThrow(/pass --yes/);
    expect(calls()).toEqual([]);
    await dosu("disconnect", "--json", "--yes");
    expect(JSON.parse(out.join("\n"))).toEqual({ id: imported().id, disconnected: true });
    expect(confirm).not.toHaveBeenCalled();
  });
});
