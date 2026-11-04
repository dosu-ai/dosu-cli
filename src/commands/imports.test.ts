/** `dosu imports connect|status|sync|disconnect` against a faked `/v1/memory/imports`: what
 * each sends and prints. */

import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { saveConfig } from "../config/config";
import { makeTestConfig } from "../config/config.test-utils";
import type { ImportStatus } from "../sources/api";
import { importsCommand } from "./imports";

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
