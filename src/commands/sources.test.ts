/** `dosu sources setup|status|list|sync|disconnect` against a faked Dosu (`/v1/memory/store`,
 * `/v1/memory/sources`), a faked sessiondb server and an in-memory bucket: where setup sends a
 * machine's sessions (always the org's store, set only by an org admin), what each command sends
 * and prints, and what it keeps in config.json. */

import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { stripVTControlCharacters } from "node:util";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { loadConfig, saveConfig } from "../config/config";
import { makeTestConfig } from "../config/config.test-utils";
import type { BucketTarget, ServerTarget, SessionTarget } from "../config/schema";
import { fakeS3 } from "../shipper/fake-s3.test-utils";
import type { Detection, Enrollment, SessionStore, SourceStatus } from "../sources/api";
import * as p from "../tui/prompts";
import { sourcesCommand } from "./sources";

vi.mock("../tui/prompts", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../tui/prompts")>()),
  text: vi.fn(),
  select: vi.fn(),
  confirm: vi.fn(),
}));

/** What a prompt answers when the person presses Ctrl-C. */
const CANCEL = Symbol.for("dosu.prompt.cancel");

/** The person's answers, by prompt; an unscripted prompt fails the test. */
function script(answers: Record<string, unknown>): void {
  const answer = async (opts: { message: string }) => {
    if (!(opts.message in answers)) throw new Error(`unscripted prompt: ${opts.message}`);
    return answers[opts.message];
  };
  vi.mocked(p.text).mockImplementation(answer as typeof p.text);
  vi.mocked(p.select).mockImplementation(answer as typeof p.select);
  vi.mocked(p.confirm).mockImplementation(answer as typeof p.confirm);
}

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

function configure(targets: SessionTarget[] = [SERVER], loggedIn = true): void {
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

/** The calls that reached Dosu (the server's and the bucket's are left out). */
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

/** Dosu answers with `impl`; the sessiondb server says what bucket it writes. */
function dosuAnswers(impl: Fetch): void {
  fetchImpl.mockImplementation(async (url, init) => {
    if (url.startsWith(SERVER.url)) return json({ owner: "james", storage });
    return impl(url, init);
  });
}

beforeEach(() => {
  home = realpathSync(mkdtempSync(join(tmpdir(), "dosu-sources-")));
  vi.stubEnv("HOME", home);
  vi.stubEnv("XDG_CONFIG_HOME", join(home, ".config"));
  vi.stubEnv("DOSU_DEV", undefined);
  vi.stubEnv("DOSU_BACKEND_URL_OVERRIDE", "https://api.dosu.test");
  for (const k of ["DOSU_SOURCE", "DOSU_BUCKET"]) {
    vi.stubEnv(`${k}_ACCESS_KEY_ID`, undefined);
    vi.stubEnv(`${k}_SECRET_ACCESS_KEY`, undefined);
  }
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

// --- setup: the org's store ----------------------------------------------------

const ENDPOINT = "http://s3.test:9000";
const HOSTED_SERVER = "https://sessiondb.dosu.test";

const BUCKET_STORE: SessionStore = {
  kind: "bucket",
  configured: true,
  server_url: null,
  url: "s3://acme-sessions/agents",
  bucket_kind: "s3",
  bucket: "acme-sessions",
  prefix: "agents",
  region: "us-east-1",
  account_id: null,
  endpoint: ENDPOINT,
  issues_tokens: false,
  updated_at: null,
  owner: null,
  source_id: null,
  members: null,
};

/** What an org with no store of its own gets where the installation runs a sessiondb. */
const HOSTED_DEFAULT: SessionStore = {
  ...BUCKET_STORE,
  kind: "hosted",
  configured: false,
  server_url: HOSTED_SERVER,
  url: "r2://sessiondb/sessions",
  endpoint: null,
  issues_tokens: true,
};

const FOUND: Detection = {
  sessiondb: false,
  layout_created_by: null,
  raw_files: 4,
  agents: { codex: 4 },
  undetected: [],
  dated_prefix: null,
  scan_raw: true,
  raw_scanned_by: null,
  raw_unavailable: null,
};

/** Dosu, its hosted sessiondb and the org's bucket: `store` is the org's (undefined: 404, no
 * store and no hosted sessiondb, until an admin's PUT sets one), `admin` whether the login is an
 * org admin, which Dosu says by listing the store's members. */
function org(options: { store?: SessionStore; admin?: boolean }) {
  let store = options.store;
  const s3 = fakeS3(ENDPOINT, "acme-sessions");
  fetchImpl.mockImplementation(async (url, init) => {
    if (url.startsWith(ENDPOINT)) return s3.fetch(url, init);
    if (url.startsWith(HOSTED_SERVER)) {
      return json({ owner: "o-org1.u-42", storage: { url: "r2://sessiondb/sessions" } });
    }
    const method = init?.method ?? "GET";
    const body = init?.body ? (JSON.parse(init.body as string) as Record<string, unknown>) : {};
    const path = url.replace("https://api.dosu.test", "");
    if (path === "/v1/memory/sources/detect") return json(FOUND);
    if (path === "/v1/memory/store/enroll") {
      if (!store) return json({ detail: "no session store" }, 404);
      const enrollment: Enrollment = {
        kind: store.kind,
        owner: (body.owner as string | undefined) ?? "o-org1.u-42",
        server_url: store.server_url,
        token: store.issues_tokens ? "minted" : null,
        expires_at: store.issues_tokens ? "2027-02-01T00:00:00Z" : null,
        url: store.url,
        bucket_kind: store.bucket_kind,
        bucket: store.bucket,
        prefix: store.prefix,
        region: store.region,
        account_id: store.account_id,
        endpoint: store.endpoint,
        source: source({ id: "src-member", owner: (body.owner as string) ?? "o-org1.u-42" }),
      };
      return json(enrollment, 201);
    }
    if (path.startsWith("/v1/memory/store") && method === "PUT") {
      const { deployment_id: _d, access_key_id: _a, secret_access_key: _s, agent, ...rest } = body;
      store = {
        ...BUCKET_STORE,
        ...(rest as Partial<SessionStore>),
        configured: true,
        url:
          body.kind === "hosted"
            ? HOSTED_DEFAULT.url
            : `${body.bucket_kind}://${body.bucket}${body.prefix ? `/${body.prefix}` : ""}`,
        server_url: body.kind === "hosted" ? HOSTED_SERVER : null,
        issues_tokens: body.kind === "hosted",
        members: [],
        raw_source_id: body.kind === "bucket" ? "src-raw" : null,
        raw_agent: (agent as string | undefined) ?? null,
      };
      return json(store);
    }
    if (path.startsWith("/v1/memory/store")) {
      if (!store) return json({ detail: "no session store" }, 404);
      // Dosu lists the store's members to org admins only.
      return json(options.admin ? { ...store, members: store.members ?? [] } : store);
    }
    return json({ detail: "unexpected" }, 500);
  });
  return s3;
}

const WRITE = ["--write-access-key-id", "AKIDWRITE", "--write-secret-access-key", "writesecret"];
const READ = ["--read-access-key-id", "AKIDREAD", "--read-secret-access-key", "readsecret"];

/** Dosu's calls, as `METHOD path` without the query. */
function steps(): string[] {
  return calls().map((c) => `${c.method} ${c.path.split("?")[0]}`);
}

describe("sources setup: an org with a store", () => {
  it("a member ships to the org's bucket: their folder is claimed, the write key tried, the target saved", async () => {
    configure([]);
    const s3 = org({ store: BUCKET_STORE });

    await dosu("setup", "--owner", "james", ...WRITE, "--yes");

    expect(steps()).toEqual(["GET /v1/memory/store", "POST /v1/memory/store/enroll"]);
    expect(calls()[1]?.body).toEqual({ deployment_id: "dep1", owner: "james" });
    expect([...s3.objects.keys()]).toContain("agents/owners/james/.probe");
    const cfg = loadConfig();
    expect(cfg.targets).toEqual([
      {
        kind: "bucket",
        name: "org",
        url: "s3://acme-sessions/agents",
        owner: "james",
        region: "us-east-1",
        endpoint: ENDPOINT,
        access_key_id: "AKIDWRITE",
        secret_access_key: "writesecret",
        source_id: "src-member",
      } satisfies BucketTarget,
    ]);
    expect(cfg.default_target).toBe("org");
    expect(out.join("\n")).toContain(
      "Sessions ship to the org's bucket s3://acme-sessions/agents as james.",
    );
  });

  it("--no-ship joins nothing, and --json says so", async () => {
    configure([]);
    org({ store: BUCKET_STORE });
    await dosu("setup", "--no-ship", "--json");
    expect(steps()).toEqual(["GET /v1/memory/store"]);
    expect(JSON.parse(out.join("\n"))).toEqual({ store: BUCKET_STORE, ship: false });
    expect(loadConfig().targets ?? []).toEqual([]);
  });

  it("refuses flags that would change the org's store, whoever runs it", async () => {
    configure([]);
    org({ store: BUCKET_STORE, admin: true });
    for (const flags of [
      ["--bucket", "s3://mine"],
      ["--hosted"],
      ["--bucket", "s3://acme-sessions/agents", "--agent", "codex", ...READ],
      [
        "--server",
        "https://s.test",
        "--bucket",
        "r2://b",
        "--account-id",
        "a",
        "--token-secret",
        "s",
      ],
    ]) {
      await expect(dosu("setup", ...flags, "--yes")).rejects.toThrow(
        "the org's sessions already go to the org's bucket s3://acme-sessions/agents; an org admin changes that with 'dosu sources store setup'",
      );
    }
    expect(steps().filter((s) => !s.startsWith("GET"))).toEqual([]);
  });
});

describe("sources setup: flags that only restate the org's store", () => {
  it("are fine: the bucket it is, the server it is, or Dosu's sessiondb a member uses by default", async () => {
    configure([]);
    org({ store: BUCKET_STORE });
    await dosu(
      "setup",
      "--bucket",
      "s3://acme-sessions/agents/",
      "--region",
      "us-east-1",
      "--no-ship",
      "--json",
    );
    expect(JSON.parse(out.join("\n"))).toEqual({ store: BUCKET_STORE, ship: false });

    const server: SessionStore = { ...HOSTED_DEFAULT, kind: "server", configured: true };
    org({ store: server });
    out = [];
    await dosu("setup", "--server", `${HOSTED_SERVER}/`, "--no-ship", "--json");
    expect(JSON.parse(out.join("\n"))).toMatchObject({ store: { kind: "server" }, ship: false });

    org({ store: HOSTED_DEFAULT, admin: false });
    out = [];
    await dosu("setup", "--hosted", "--no-ship", "--json");
    expect(JSON.parse(out.join("\n"))).toMatchObject({ store: { kind: "hosted" }, ship: false });
    expect(steps().filter((s) => !s.startsWith("GET"))).toEqual([]);
  });
});

describe("sources setup: shipping to the org's bucket", () => {
  it("--json hides the write key; --name and --no-default keep the current default", async () => {
    configure([SERVER]);
    saveConfig({ ...loadConfig(), default_target: "team" });
    org({ store: BUCKET_STORE });

    await dosu("setup", "--owner", "james", ...WRITE, "--name", "mine", "--no-default", "--yes");

    expect(loadConfig().default_target).toBe("team");
    expect(loadConfig().targets?.map((t) => t.name)).toEqual(["team", "mine"]);
    expect(out.join("\n")).toContain("as james ('dosu sync --target mine').");

    out = [];
    await dosu("setup", "--owner", "james", ...WRITE, "--json");
    const printed = JSON.parse(out.join("\n"));
    expect(printed.target).toMatchObject({ name: "org", secret_access_key: "***" });
    expect(out.join("\n")).not.toContain("writesecret");
  });

  it("--no-ship says how to ship from here later", async () => {
    configure([]);
    org({ store: BUCKET_STORE });
    await dosu("setup", "--no-ship");
    expect(out.join("\n")).toContain(
      "This machine ships nothing. 'dosu sources setup' ships from here later.",
    );
  });

  it("saves nothing when the member cancels picking their folder", async () => {
    configure([]);
    org({ store: BUCKET_STORE });
    script({ "Your folder in the bucket (owner)": CANCEL });
    await dosu("setup", "--ship");
    expect(out.join("\n")).toContain("Cancelled; nothing saved.");
    expect(loadConfig().targets ?? []).toEqual([]);
  });
});

describe("sources setup: when Dosu cannot say where sessions live", () => {
  it("says why, and saves nothing", async () => {
    configure([]);
    dosuAnswers(async () => json({ detail: "busy" }, 503));
    await expect(dosu("setup", "--yes")).rejects.toThrow(
      "Could not ask Dosu where the org's sessions live: HTTP 503: busy",
    );
    expect(loadConfig().targets ?? []).toEqual([]);
  });
});

describe("sources setup: no store, a member", () => {
  it("uses Dosu's sessiondb where it runs: enrolled, the minted token tried, nothing pasted", async () => {
    configure([]);
    org({ store: HOSTED_DEFAULT, admin: false });

    await dosu("setup", "--yes", "--json");

    expect(steps()).toEqual(["GET /v1/memory/store", "POST /v1/memory/store/enroll"]);
    const printed = JSON.parse(out.join("\n"));
    expect(printed.target).toMatchObject({
      name: "org",
      url: HOSTED_SERVER,
      owner: "o-org1.u-42",
      token: "***",
      store: true,
      hosted: true,
    });
    expect(out.join("\n")).not.toContain("minted");
    expect(loadConfig().targets?.[0]).toMatchObject({ token: "minted", source_id: "src-member" });
  });

  it("cannot choose a bucket: only an org admin sets where sessions live", async () => {
    configure([]);
    org({ store: HOSTED_DEFAULT, admin: false });
    await expect(dosu("setup", "--bucket", "s3://mine", ...READ, "--yes")).rejects.toThrow(
      "only an org admin sets where the org's sessions live",
    );
    expect(steps().filter((s) => !s.startsWith("GET"))).toEqual([]);
  });

  it("is told an org admin must choose, and exits non-zero, when there is nowhere at all", async () => {
    configure([]);
    org({ admin: false });
    await expect(dosu("setup", "--yes")).rejects.toThrow(
      /Your org has no session store yet.*An org admin sets one with .*dosu sources store setup/s,
    );
    expect(steps()).toEqual(["GET /v1/memory/store"]);
    expect(loadConfig().targets ?? []).toEqual([]);
  });
});

describe("sources setup: interactively", () => {
  let tty: boolean | undefined;
  beforeEach(() => {
    tty = process.stdin.isTTY;
    Object.defineProperty(process.stdin, "isTTY", { value: true, configurable: true });
  });
  afterEach(() => {
    Object.defineProperty(process.stdin, "isTTY", { value: tty, configurable: true });
  });

  it("a member is told an org admin must choose, without failing", async () => {
    configure([]);
    org({ admin: false });
    await dosu("setup");
    expect(out.join("\n")).toContain("Your org has no session store yet");
    expect(loadConfig().targets ?? []).toEqual([]);
  });

  it("an admin who cancels the first question changes nothing", async () => {
    configure([]);
    org({ store: HOSTED_DEFAULT, admin: true });
    script({ "Where do sessions live?": CANCEL });
    await dosu("setup");
    expect(out.join("\n")).toContain("Cancelled; nothing saved.");
    expect(steps()).toEqual(["GET /v1/memory/store"]);
  });

  it("an admin gives Dosu's read-only key when asked, sets the bucket, and ships nothing", async () => {
    configure([]);
    org({ store: HOSTED_DEFAULT, admin: true });
    script({
      "Dosu's read-only keys (GetObject + ListBucket): access key id": "AKIDREAD",
      "Dosu's read-only keys (GetObject + ListBucket): secret access key": "readsecret",
      "Make it the org's session store?": "yes",
    });

    await dosu(
      "setup",
      "--bucket",
      "s3://acme-sessions/agents",
      "--region",
      "us-east-1",
      "--endpoint",
      ENDPOINT,
      "--no-ship",
    );

    expect(steps()).toEqual([
      "GET /v1/memory/store",
      "POST /v1/memory/sources/detect",
      "PUT /v1/memory/store",
    ]);
    expect(calls()[2]?.body).toMatchObject({ access_key_id: "AKIDREAD" });
    const text = out.join("\n");
    expect(text).toContain("each file's format detected");
    expect(text).toContain("This machine ships nothing.");
  });
});

describe("sources setup: no store, an org admin", () => {
  it("sets the org's bucket after Dosu looked (with --agent), then ships this machine to its own folder", async () => {
    configure([]);
    const s3 = org({ store: HOSTED_DEFAULT, admin: true });

    await dosu(
      "setup",
      "--bucket",
      "s3://acme-sessions/agents",
      "--region",
      "us-east-1",
      "--endpoint",
      ENDPOINT,
      ...READ,
      "--agent",
      "codex",
      "--owner",
      "james",
      ...WRITE,
      "--yes",
    );

    expect(steps()).toEqual([
      "GET /v1/memory/store",
      "POST /v1/memory/sources/detect",
      "PUT /v1/memory/store",
      "POST /v1/memory/store/enroll",
    ]);
    expect(calls()[1]?.body).toMatchObject({ bucket: "acme-sessions", agent: "codex" });
    expect(calls()[2]?.body).toEqual({
      deployment_id: "dep1",
      kind: "bucket",
      bucket_kind: "s3",
      bucket: "acme-sessions",
      prefix: "agents",
      region: "us-east-1",
      endpoint: ENDPOINT,
      access_key_id: "AKIDREAD",
      secret_access_key: "readsecret",
      agent: "codex",
    });
    expect([...s3.objects.keys()]).toContain("agents/owners/james/.probe");
    const text = out.join("\n");
    expect(text).toContain("s3://acme-sessions/agents: 4 raw files (all read as codex)");
    expect(text).toContain("The org's sessions go to the org's bucket s3://acme-sessions/agents.");
    expect(text).toContain("read as codex");
    expect(text).toContain("A write key to the bucket can add to the org's memory");
    expect(text).toContain("Sessions ship to the org's bucket s3://acme-sessions/agents as james.");
    expect(loadConfig().targets?.[0]).toMatchObject({ name: "org", access_key_id: "AKIDWRITE" });
  });

  it("--hosted --no-ship sets Dosu's sessiondb for the org and ships nothing from here", async () => {
    configure([]);
    org({ store: HOSTED_DEFAULT, admin: true });

    await dosu("setup", "--hosted", "--no-ship");

    expect(steps()).toEqual(["GET /v1/memory/store", "PUT /v1/memory/store"]);
    expect(calls()[1]?.body).toEqual({ deployment_id: "dep1", kind: "hosted" });
    expect(out.join("\n")).toContain("The org's sessions go to Dosu's sessiondb.");
    expect(out.join("\n")).toContain("This machine ships nothing");
    expect(loadConfig().targets ?? []).toEqual([]);
  });

  it("keeps the hosted default under --yes when it names no store", async () => {
    configure([]);
    org({ store: HOSTED_DEFAULT, admin: true });
    await dosu("setup", "--yes", "--no-ship");
    expect(steps().filter((s) => !s.startsWith("GET"))).toEqual([]);
  });

  it("is sent to 'dosu sources store setup' when Dosu has no store to offer at all", async () => {
    configure([]);
    org({ admin: true });
    await expect(dosu("setup", "--yes")).rejects.toThrow(/dosu sources store setup/);
    expect(steps()).toEqual(["GET /v1/memory/store"]);
  });
});

describe("sources setup: flags", () => {
  it("refuses what does not go together, before calling Dosu", async () => {
    await expect(dosu("setup", "--hosted", "--bucket", "s3://a")).rejects.toThrow(
      /--hosted is Dosu's/,
    );
    await expect(dosu("setup", "--hosted", "--token", "sdb_x")).rejects.toThrow(
      /--hosted is Dosu's sessiondb/,
    );
    await expect(dosu("setup", "--write-access-key-id", "AKID")).rejects.toThrow(/go together/);
    await expect(dosu("setup", "--read-access-key-id", "AKID")).rejects.toThrow(/go together/);
    await expect(dosu("setup", "--agent", "notepad")).rejects.toThrow(/--agent must be one of/);
    await expect(dosu("setup", "--hosted", "--agent", "codex")).rejects.toThrow(
      /it goes with --bucket/,
    );
    expect(apiCalls()).toEqual([]);
  });

  it("needs a login", async () => {
    configure([], false);
    await expect(dosu("setup", "--hosted")).rejects.toThrow(/not logged in to Dosu/);
  });
});

describe("sources connect", () => {
  it("is gone: a bucket is the org's, set by an org admin", async () => {
    await expect(
      dosu("connect", "--bucket", "s3://acme/logs", "--access-key-id", "x"),
    ).rejects.toThrow(/'dosu sources connect' is gone: a bucket is always the org's/);
    expect(apiCalls()).toEqual([]);
    expect(sourcesCommand().helpInformation()).not.toMatch(/^\s+connect\b/m);
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
    expect(text).toContain("Bucket:     team → s3://acme-sessions/agents");
    expect(text).toContain(
      "Folder:     owners/james/ · read 3m ago · 4 processed · 2 changes behind",
    );
    expect(text).toContain("Cursor:     2026-10-22T00:00:00.000Z-abc · re-reads 300s of lag");
    expect(text).toContain("Raw files:  not read by this connection");
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

    await expect(dosu("status")).rejects.toThrow(/Dosu reads nothing through target team/);
    expect(savedSourceId()).toBeUndefined();
  });

  it("status finds a bucket target's source by its own URL and owner", async () => {
    configure([
      {
        kind: "bucket",
        name: "mine",
        url: "s3://acme-sessions/agents",
        owner: "james",
        region: "us-east-1",
        access_key_id: "AKIDWRITE",
        secret_access_key: "writesecret",
      },
    ]);
    dosuAnswers(async () => json({ sources: [source()] }));

    await dosu("status");

    expect(out.join("\n")).toContain("mine → s3://acme-sessions/agents");
    expect(fetchImpl.mock.calls.some(([url]) => url.startsWith(SERVER.url))).toBe(false);
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
    expect(out.join("\n")).toContain('Read queued for "team"');
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

describe("sources status and list: the folder and the raw files", () => {
  const RAW_SOURCE = source({
    id: "33333333-3333-4333-8333-333333333333",
    name: "ci logs",
    owner: "",
    url: "s3://acme/ci",
    scan_raw: true,
    files: 12,
    sessions: 9,
    raw_synced_at: new Date(Date.now() - 2 * 60_000).toISOString(),
    raw_listed: 14,
    raw_imported: 3,
    raw_remaining: 2,
    raw_error: "AccessDenied: GetObject",
    raw_error_count: 2,
    recent_files: [
      {
        key: "ci/run-1.jsonl",
        agent: "codex",
        session_id: "s1",
        size: 10,
        shipped_bytes: 10,
        outcome: "imported",
        detail: null,
        content_hash: null,
        imported_at: new Date(Date.now() - 60_000).toISOString(),
      },
      {
        key: "ci/odd.jsonl",
        agent: null,
        session_id: "s2",
        size: 10,
        shipped_bytes: 0,
        outcome: "unreadable",
        detail: "no format matched",
        content_hash: null,
        imported_at: new Date(Date.now() - 60_000).toISOString(),
      },
    ],
  });

  it("--source shows a connection with no target: its raw files, formats, last scan and error", async () => {
    configure([]);
    dosuAnswers(async (url) =>
      url.endsWith(RAW_SOURCE.id) ? json(RAW_SOURCE) : json({ sources: [RAW_SOURCE] }),
    );

    await dosu("status", "--source", "ci logs");

    const text = out.join("\n");
    expect(text).toContain("Bucket:     s3://acme/ci");
    expect(text).toContain("Folder:     none; only the raw files are read");
    expect(text).toContain("Raw files:  12 files · 9 sessions · recent: codex ×1, unknown ×1");
    expect(text).toContain("Last scan:  2m ago · 14 listed · 3 imported · 2 remaining");
    expect(text).toContain("Raw error:  AccessDenied: GetObject (2 in a row)");
    expect(text).toMatch(/unknown\s+unreadable\s+ci\/odd\.jsonl/);
  });

  it("with no target, the login's only connection; with several, asks which", async () => {
    configure([]);
    const pending = source({
      ...RAW_SOURCE,
      files: 0,
      sessions: 0,
      pending: true,
      raw_error: null,
      recent_files: [],
    });
    dosuAnswers(async (url) =>
      url.endsWith(RAW_SOURCE.id) ? json(pending) : json({ sources: [pending] }),
    );
    await dosu("status");
    expect(out.join("\n")).toContain("Raw files:  none yet · detected per file");
    expect(out.join("\n")).toContain("Waiting for files: Dosu checks every 5 minutes.");

    dosuAnswers(async () => json({ sources: [RAW_SOURCE, source()] }));
    await expect(dosu("status")).rejects.toThrow(/2 connections; say which with --source/);
    await expect(dosu("status", "--source", "nope")).rejects.toThrow(/no connection 'nope'/);
    await expect(dosu("status", "--source", "x", "--target", "team")).rejects.toThrow(/give one/);
    dosuAnswers(async () => json({ sources: [] }));
    await expect(dosu("sync")).rejects.toThrow(/nothing connected/);
  });

  it("list shows what each connection reads, and waiting connections", async () => {
    dosuAnswers(async () =>
      json({
        sources: [
          source(),
          RAW_SOURCE,
          source({
            id: "4",
            name: "empty",
            owner: "",
            url: "s3://e",
            scan_raw: true,
            pending: true,
          }),
          source({
            id: "5",
            name: "named",
            owner: "",
            url: "s3://n",
            scan_raw: true,
            files: 1,
            sessions: 1,
            agent: "pi",
          }),
        ],
      }),
    );

    await dosu("list");

    const rows = out.join("\n").split("\n");
    expect(rows.find((r) => r.startsWith("team"))).toMatch(/owners\/james\/\s+—\s+never\s+ok/);
    expect(rows.find((r) => r.startsWith("ci logs"))).toMatch(
      /—\s+12 files · 9 sessions\s+2m ago\s+raw error ×2/,
    );
    expect(rows.find((r) => r.startsWith("empty"))).toMatch(
      /waiting for files\s+never\s+waiting for files/,
    );
    expect(rows.find((r) => r.startsWith("named"))).toContain("1 file · 1 session (pi)");
  });

  it("a disabled connection read as one format, with errors but no scan yet", async () => {
    configure([]);
    const off = source({
      ...RAW_SOURCE,
      enabled: false,
      agent: "pi",
      files: 0,
      recent_files: undefined,
      raw_synced_at: null,
      raw_error: "boom",
      raw_error_count: undefined,
      last_error: "bad key",
      error_count: 3,
    });
    dosuAnswers(async (url) => (url.endsWith(off.id) ? json(off) : json({ sources: [off] })));

    await dosu("status");

    const text = stripVTControlCharacters(out.join("\n"));
    expect(text).toContain("○ ci logs");
    expect(text).toContain("Raw files:  none yet · all read as pi");
    expect(text).not.toContain("Last scan:");
    expect(text).toContain("Disabled: you moved to another folder");
    expect(text).toContain("Last error: bad key (3 in a row)");
    expect(text).toContain("Raw error:  boom (1 in a row)");

    out = [];
    dosuAnswers(async () =>
      json({
        sources: [
          off,
          source({
            ...RAW_SOURCE,
            id: "7",
            name: "counted",
            files: 2,
            sessions: undefined,
            raw_error_count: undefined,
          }),
        ],
      }),
    );
    await dosu("list");
    const rows = out.join("\n").split("\n");
    expect(rows.find((r) => r.startsWith("ci logs"))).toContain("disabled");
    expect(rows.find((r) => r.startsWith("counted"))).toMatch(
      /2 files · 0 sessions .*raw error ×1/,
    );
  });

  it("list --json, and says how to connect when there is nothing", async () => {
    dosuAnswers(async () => json({ sources: [] }));
    await dosu("list");
    expect(out.join("\n")).toContain("Nothing connected.");
    out = [];
    await dosu("list", "--json");
    expect(JSON.parse(out.join("\n"))).toEqual({ sources: [] });
  });

  it("disconnect --source forgets a connection no target holds", async () => {
    configure([]);
    dosuAnswers(async (url, init) =>
      init?.method === "DELETE"
        ? new Response(null, { status: 204 })
        : url.endsWith(RAW_SOURCE.id)
          ? json(RAW_SOURCE)
          : json({ sources: [RAW_SOURCE] }),
    );

    await dosu("disconnect", "--source", RAW_SOURCE.id, "--yes");

    expect(calls().at(-1)).toEqual({
      method: "DELETE",
      path: `/v1/memory/sources/${RAW_SOURCE.id}`,
    });
    expect(out.join("\n")).toContain('"ci logs" disconnected.');
  });
});
