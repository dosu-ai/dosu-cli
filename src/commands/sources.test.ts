/** `dosu sources connect|status|sync|disconnect` against a faked `/v1/memory/sources` and a
 * faked sessiondb server (which says what bucket it writes): what each sends, what it prints,
 * and what it keeps in config.json. */

import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { loadConfig, saveConfig } from "../config/config";
import { makeTestConfig } from "../config/config.test-utils";
import type { ServerTarget } from "../config/schema";
import type { SourceStatus } from "../sources/api";
import { parseStdinCredentials, sourcesCommand, wizardInputFromOptions } from "./sources";

let home: string;
type Fetch = (input: string, init?: RequestInit) => Promise<Response>;
let fetchImpl: ReturnType<typeof vi.fn<Fetch>>;
let out: string[];

const SERVER: ServerTarget = {
  name: "team",
  url: "https://sessions.example.com",
  owner: "james",
  token: "sdb_test",
};

/** What the server reports it writes (`GET /v1/me`). */
let storage: Record<string, unknown>;
const SERVER_STORAGE = {
  url: "s3://acme-sessions/agents",
  region: "us-east-1",
};

function source(extra: Partial<SourceStatus> = {}): SourceStatus {
  return {
    id: "11111111-1111-4111-8111-111111111111",
    name: "team",
    org: "org1",
    deployment_id: "dep1",
    kind: "s3",
    bucket: "acme-sessions",
    prefix: "agents",
    owner: "james",
    url: "s3://acme-sessions/agents",
    region: "us-east-1",
    account_id: null,
    endpoint: null,
    lag_seconds: 300,
    enabled: true,
    cursor: null,
    cursor_at: null,
    last_synced_at: null,
    last_error: null,
    error_count: 0,
    last_sync_processed: 0,
    last_sync_remaining: 0,
    created_at: "2026-10-22T00:00:00.000Z",
    ...extra,
  };
}

function configure(targets: ServerTarget[] = [SERVER], loggedIn = true): void {
  saveConfig({
    ...makeTestConfig({
      access_token: "t",
      refresh_token: "r",
      expires_at: 0,
      ...(loggedIn ? { api_key: "sk_test", deployment_id: "dep1", org_id: "org1" } : {}),
    }),
    targets,
  });
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status });
}

/** The calls that reached Dosu (the server's storage lookups are left out). */
function apiCalls(): Array<[string, RequestInit?]> {
  return fetchImpl.mock.calls.filter(([url]) => url.startsWith("https://api.dosu.test"));
}

function calls(): Array<{ method: string; path: string; body?: unknown }> {
  return apiCalls().map(([url, init]) => ({
    method: init?.method ?? "GET",
    path: url.replace("https://api.dosu.test", ""),
    ...(init?.body ? { body: JSON.parse(init.body as string) } : {}),
  }));
}

/** Dosu answers with `impl`; the sessiondb server always says what bucket it writes. */
function dosuAnswers(impl: Fetch): void {
  fetchImpl.mockImplementation(async (url, init) =>
    url.startsWith(SERVER.url) ? json({ owner: "james", storage }) : impl(url, init),
  );
}

beforeEach(() => {
  home = realpathSync(mkdtempSync(join(tmpdir(), "dosu-sources-")));
  vi.stubEnv("HOME", home);
  vi.stubEnv("XDG_CONFIG_HOME", join(home, ".config"));
  vi.stubEnv("DOSU_DEV", undefined);
  vi.stubEnv("DOSU_BACKEND_URL_OVERRIDE", "https://api.dosu.test");
  vi.stubEnv("DOSU_SOURCE_ACCESS_KEY_ID", undefined);
  vi.stubEnv("DOSU_SOURCE_SECRET_ACCESS_KEY", undefined);
  storage = { ...SERVER_STORAGE };
  fetchImpl = vi.fn<Fetch>();
  dosuAnswers(async () => json({ sources: [] }));
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
  const cmd = sourcesCommand();
  cmd.exitOverride();
  await cmd.parseAsync(["node", "dosu", ...args]);
}

function savedSourceId(): string | undefined {
  return loadConfig().targets?.find((t) => t.name === "team")?.source_id;
}

describe("sources connect", () => {
  it("registers the target with the keys given, and keeps the source id on it", async () => {
    dosuAnswers(async (_url, init) =>
      init?.method === "POST"
        ? json(source({ layout_created_by: "dosu-cli/1.0" }), 201)
        : json({ sources: [] }),
    );

    await dosu("connect", "--access-key-id", "AKIAREAD", "--secret-access-key", "readsecret");

    expect(calls()).toEqual([
      { method: "GET", path: "/v1/memory/sources?deployment_id=dep1" },
      {
        method: "POST",
        path: "/v1/memory/sources",
        body: {
          deployment_id: "dep1",
          kind: "s3",
          bucket: "acme-sessions",
          prefix: "agents",
          owner: "james",
          region: "us-east-1",
          access_key_id: "AKIAREAD",
          secret_access_key: "readsecret",
          name: "team",
        },
      },
    ]);
    expect(apiCalls()[1]?.[1]?.headers).toMatchObject({ "X-Dosu-API-Key": "sk_test" });
    expect(savedSourceId()).toBe(source().id);
    expect(out.join("\n")).toContain('Source "team" connected');
    expect(out.join("\n")).toContain("keys from flags");
    expect(out.join("\n")).toContain("layout written by dosu-cli/1.0");
  });

  it("takes Dosu's keys from DOSU_SOURCE_*, with --lag and --name", async () => {
    dosuAnswers(async (_url, init) =>
      init?.method === "POST" ? json(source(), 201) : json({ sources: [] }),
    );
    vi.stubEnv("DOSU_SOURCE_ACCESS_KEY_ID", "AKIAENV");
    vi.stubEnv("DOSU_SOURCE_SECRET_ACCESS_KEY", "envsecret");

    await dosu("connect", "--lag", "60", "--name", "acme bucket");

    expect(calls()[1]?.body).toMatchObject({
      access_key_id: "AKIAENV",
      secret_access_key: "envsecret",
      lag_seconds: 60,
      name: "acme bucket",
    });
    expect(out.join("\n")).toContain("keys from DOSU_SOURCE_* environment");
  });

  it("--endpoint tells Dosu to read through a different endpoint than the server writes to", async () => {
    storage = { ...SERVER_STORAGE, endpoint: "http://127.0.0.1:9000" };
    dosuAnswers(async (_url, init) =>
      init?.method === "POST" ? json(source(), 201) : json({ sources: [] }),
    );

    await dosu(
      "connect",
      "--endpoint",
      "http://minio.internal:9000",
      "--access-key-id",
      "AKIAREAD",
      "--secret-access-key",
      "readsecret",
    );

    expect(calls()[1]?.body).toMatchObject({ endpoint: "http://minio.internal:9000" });
  });

  it("reads the keys from stdin with --read-credentials-stdin", async () => {
    dosuAnswers(async (_url, init) =>
      init?.method === "POST" ? json(source(), 201) : json({ sources: [] }),
    );
    vi.spyOn(process, "stdin", "get").mockReturnValue(
      Readable.from(["AKIASTDIN\nstdinsecret\n"]) as unknown as typeof process.stdin,
    );

    await dosu("connect", "--read-credentials-stdin");

    expect(calls()[1]?.body).toMatchObject({
      access_key_id: "AKIASTDIN",
      secret_access_key: "stdinsecret",
    });
  });

  it("says where the keys can come from when none were given", async () => {
    await expect(dosu("connect")).rejects.toThrow(/no credentials for Dosu to read the bucket/);
    expect(calls().map((c) => c.method)).toEqual(["GET"]);
  });

  it("reports an already-connected target instead of connecting it twice", async () => {
    dosuAnswers(async () => json({ sources: [source()] }));

    await dosu("connect");

    expect(calls().map((c) => c.method)).toEqual(["GET"]);
    expect(savedSourceId()).toBe(source().id);
    expect(out.join("\n")).toContain("already connected");
  });

  it("turns the backend's refusal into the exact reason", async () => {
    dosuAnswers(async (_url, init) =>
      init?.method === "POST"
        ? json({ detail: "AccessDenied listing owners/james/changes/" }, 400)
        : json({ sources: [] }),
    );
    await expect(
      dosu("connect", "--access-key-id", "AKIAREAD", "--secret-access-key", "readsecret"),
    ).rejects.toThrow(/could not read s3:\/\/acme-sessions\/agents as owner james .*AccessDenied/);
    expect(savedSourceId()).toBeUndefined();
  });

  it("refuses a server that writes a folder on its own disk: Dosu cannot read that", async () => {
    storage = { url: "file:///srv/sessions" };
    vi.stubEnv("DOSU_SOURCE_ACCESS_KEY_ID", "AKIAENV");
    vi.stubEnv("DOSU_SOURCE_SECRET_ACCESS_KEY", "envsecret");
    await expect(dosu("connect")).rejects.toThrow(/not a bucket Dosu can read/);
    expect(calls().map((c) => c.method)).toEqual(["GET"]);
  });

  it("needs a login: a source is Dosu reading on your behalf", async () => {
    configure([SERVER], false);
    await expect(dosu("connect")).rejects.toThrow(/not logged in to Dosu/);
  });

  it("asks for --target when several are configured", async () => {
    configure([SERVER, { ...SERVER, name: "other", url: "https://other.example.com" }]);
    await expect(dosu("connect")).rejects.toThrow(/several servers are configured \(team, other\)/);
  });
});

describe("sources status", () => {
  it("prints what Dosu has read of the target's source, by the remembered id", async () => {
    configure([{ ...SERVER, source_id: source().id }]);
    const now = Date.now();
    dosuAnswers(async () =>
      json(
        source({
          cursor: "2026-10-22T00:00:00.000Z-abc",
          last_synced_at: new Date(now - 3 * 60_000).toISOString(),
          last_sync_processed: 4,
          last_sync_remaining: 2,
          last_error: "ReadTimeout",
          error_count: 1,
          recent: [
            {
              key: "owners/james/changes/2026-10-22T00:00:00.000Z-abc.json",
              kind: "published",
              outcome: "ingested",
              detail: null,
              trace_id: "t1",
              entry_at: "2026-10-22T00:00:00.000Z",
              processed_at: new Date(now - 60_000).toISOString(),
            },
          ],
        }),
      ),
    );

    await dosu("status");

    expect(calls()).toEqual([{ method: "GET", path: `/v1/memory/sources/${source().id}` }]);
    const text = out.join("\n");
    expect(text).toContain("Target:     team → s3://acme-sessions/agents, owner james");
    expect(text).toContain("Last sync:  3m ago · 4 processed");
    expect(text).toContain("Cursor:     2026-10-22T00:00:00.000Z-abc");
    expect(text).toContain("Behind:     2 changes · re-reads 300s of lag");
    expect(text).toContain("Last error: ReadTimeout (1 in a row)");
    expect(text).toMatch(/published\s+ingested\s+owners\/james\/changes/);
  });

  it("finds the source by bucket and owner when config has no id, and remembers it", async () => {
    dosuAnswers(async (url) =>
      url.endsWith(`/${source().id}`)
        ? json(source())
        : json({ sources: [source({ id: "other", owner: "someone-else" }), source()] }),
    );

    await dosu("status", "--json");

    expect(calls().map((c) => c.path)).toEqual(["/v1/memory/sources?deployment_id=dep1"]);
    expect(savedSourceId()).toBe(source().id);
    expect(JSON.parse(out.join("\n"))).toMatchObject({ id: source().id });
  });

  it("forgets a remembered id the backend no longer knows", async () => {
    configure([{ ...SERVER, source_id: "gone" }]);
    dosuAnswers(async (url) =>
      url.endsWith("/gone") ? json({ detail: "not found" }, 404) : json({ sources: [] }),
    );

    await expect(dosu("status")).rejects.toThrow(/is not connected to Dosu/);
    expect(savedSourceId()).toBeUndefined();
  });

  it("--all lists every source under the login", async () => {
    dosuAnswers(async () =>
      json({ sources: [source(), source({ id: "2", name: "other", url: "r2://o/p" })] }),
    );
    await dosu("status", "--all");
    const text = out.join("\n");
    expect(text).toContain("team");
    expect(text).toContain("r2://o/p");
    expect(text).toContain("never");
  });
});

describe("sources sync and disconnect", () => {
  it("sync queues a read now", async () => {
    configure([{ ...SERVER, source_id: source().id }]);
    dosuAnswers(async (_url, init) =>
      init?.method === "POST"
        ? json({ id: source().id, status: "queued", workflow_id: "wf-1" }, 202)
        : json(source()),
    );

    await dosu("sync");

    expect(calls().map((c) => [c.method, c.path])).toEqual([
      ["GET", `/v1/memory/sources/${source().id}`],
      ["POST", `/v1/memory/sources/${source().id}/sync`],
    ]);
    expect(out.join("\n")).toContain('Sync queued for "team"');
  });

  it("disconnect --yes deletes the source and drops the id from config", async () => {
    configure([{ ...SERVER, source_id: source().id }]);
    dosuAnswers(async (_url, init) =>
      init?.method === "DELETE" ? new Response(null, { status: 204 }) : json(source()),
    );

    await dosu("disconnect", "--yes");

    expect(calls().map((c) => [c.method, c.path])).toEqual([
      ["GET", `/v1/memory/sources/${source().id}`],
      ["DELETE", `/v1/memory/sources/${source().id}`],
    ]);
    expect(savedSourceId()).toBeUndefined();
    expect(out.join("\n")).toContain("disconnected; team is an archive again");
  });
});

describe("parseStdinCredentials", () => {
  it("accepts two lines, three lines, and JSON in either casing", () => {
    expect(parseStdinCredentials("id\nsecret\n")).toEqual({
      access_key_id: "id",
      secret_access_key: "secret",
    });
    expect(parseStdinCredentials("id\nsecret\ntoken")).toEqual({
      access_key_id: "id",
      secret_access_key: "secret",
      session_token: "token",
    });
    expect(
      parseStdinCredentials('{"accessKeyId":"id","secretAccessKey":"secret","sessionToken":"t"}'),
    ).toEqual({ access_key_id: "id", secret_access_key: "secret", session_token: "t" });
  });

  it("rejects what it cannot read", () => {
    expect(() => parseStdinCredentials("only-one-line")).toThrow(/line 1 .* line 2/);
    expect(() => parseStdinCredentials("{not json")).toThrow(/not valid JSON/);
    expect(() => parseStdinCredentials('{"access_key_id":"id"}')).toThrow(/needs access_key_id/);
  });
});

describe("wizardInputFromOptions", () => {
  it("maps every flag to its wizard answer and leaves out what was not given", () => {
    expect(wizardInputFromOptions({})).toEqual({});
    expect(
      wizardInputFromOptions({
        server: "https://sessions.example.com",
        token: "sdb_x",
        name: "mine",
        readAccessKeyId: "R",
        readSecretAccessKey: "rs",
        connect: false,
        default: false,
        yes: true,
      }),
    ).toEqual({
      server: "https://sessions.example.com",
      token: "sdb_x",
      name: "mine",
      read: { access_key_id: "R", secret_access_key: "rs" },
      connect: false,
      makeDefault: false,
      yes: true,
    });
  });

  it("rejects half a key pair", () => {
    expect(() => wizardInputFromOptions({ readSecretAccessKey: "rs" })).toThrow(/go together/);
    expect(() => wizardInputFromOptions({ readAccessKeyId: "R" })).toThrow(/go together/);
  });
});
