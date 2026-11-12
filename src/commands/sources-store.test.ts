/** `dosu sources store setup|status|join` against a faked `/v1/memory/store`: what setup sends
 * for each kind, what status prints to a member and to an admin, and how join hands off. */

import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { loadConfig, saveConfig } from "../config/config";
import { makeTestConfig } from "../config/config.test-utils";
import { type Detection, type SessionStore, storeApi } from "../sources/api";
import { joinOrgStore } from "../sources/store";
import * as p from "../tui/prompts";
import { sourcesCommand } from "./sources";

vi.mock("../tui/prompts", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../tui/prompts")>()),
  text: vi.fn(),
  select: vi.fn(),
  confirm: vi.fn(),
}));
vi.mock("../sources/store", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../sources/store")>()),
  joinOrgStore: vi.fn(),
}));

const DOSU = "https://api.dosu.test";
type Fetch = (input: string, init?: RequestInit) => Promise<Response>;

const STORE: SessionStore = {
  kind: "bucket",
  configured: true,
  server_url: null,
  url: "s3://acme-sessions/agents",
  bucket_kind: "s3",
  bucket: "acme-sessions",
  prefix: "agents",
  region: "us-east-1",
  account_id: null,
  endpoint: null,
  issues_tokens: false,
  updated_at: null,
  owner: null,
  source_id: null,
  members: null,
};

let home: string;
let out: string[];
let fetchImpl: ReturnType<typeof vi.fn<Fetch>>;

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status });
}

/** What `POST /v1/memory/sources/detect` answers. */
let detection: Detection;
const FOUND: Detection = {
  sessiondb: true,
  layout_created_by: "dosu-cli/1.0",
  raw_files: 3,
  agents: { codex: 2 },
  undetected: [],
  dated_prefix: null,
  scan_raw: true,
  raw_scanned_by: null,
  raw_unavailable: null,
};

/** Dosu answers Dosu's look at a bucket with `detection`, and every other call with `answer`,
 * echoing a PUT's body back as the store. */
function dosuAnswers(answer: (method: string, body?: Record<string, unknown>) => Response): void {
  fetchImpl.mockImplementation(async (url, init) => {
    if (url.endsWith("/v1/memory/sources/detect")) return json(detection);
    const body = init?.body ? (JSON.parse(init.body as string) as Record<string, unknown>) : {};
    return answer(init?.method ?? "GET", init?.body ? body : undefined);
  });
}

function calls(): Array<{ method: string; path: string; body?: Record<string, unknown> }> {
  return fetchImpl.mock.calls.map(([url, init]) => ({
    method: init?.method ?? "GET",
    path: url.replace(DOSU, ""),
    ...(init?.body ? { body: JSON.parse(init.body as string) } : {}),
  }));
}

/** The body of the one `PUT /v1/memory/store` sent (setup reads the store, and looks at a bucket,
 * first). */
function put(): Record<string, unknown> | undefined {
  const puts = calls().filter((c) => c.method === "PUT");
  expect(puts).toHaveLength(1);
  return puts[0]?.body;
}

function script(answers: Record<string, unknown>): void {
  const answer = async (opts: { message: string }) => {
    if (!(opts.message in answers)) throw new Error(`unscripted prompt: ${opts.message}`);
    return answers[opts.message];
  };
  vi.mocked(p.text).mockImplementation(answer as typeof p.text);
  vi.mocked(p.select).mockImplementation(answer as typeof p.select);
}

async function dosu(...args: string[]): Promise<void> {
  const cmd = sourcesCommand();
  cmd.exitOverride();
  await cmd.parseAsync(["node", "dosu", "store", ...args]);
}

beforeEach(() => {
  home = realpathSync(mkdtempSync(join(tmpdir(), "dosu-store-cmd-")));
  vi.stubEnv("HOME", home);
  vi.stubEnv("XDG_CONFIG_HOME", join(home, ".config"));
  vi.stubEnv("DOSU_DEV", undefined);
  vi.stubEnv("DOSU_BACKEND_URL_OVERRIDE", DOSU);
  for (const name of [
    "DOSU_SOURCE_ACCESS_KEY_ID",
    "DOSU_SOURCE_SECRET_ACCESS_KEY",
    "DOSU_SOURCE_SESSION_TOKEN",
    "DOSU_STORE_TOKEN_SECRET",
  ]) {
    vi.stubEnv(name, undefined);
  }
  saveConfig(
    makeTestConfig({
      access_token: "t",
      refresh_token: "r",
      expires_at: 0,
      api_key: "sk_test",
      deployment_id: "dep1",
      org_id: "org1",
    }),
  );
  fetchImpl = vi.fn<Fetch>();
  detection = { ...FOUND };
  dosuAnswers((method, body) => json(method === "PUT" ? { ...STORE, ...body } : STORE));
  vi.stubGlobal("fetch", fetchImpl);
  out = [];
  vi.spyOn(console, "log").mockImplementation((...args: unknown[]) => {
    out.push(args.join(" "));
  });
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.clearAllMocks();
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  rmSync(home, { recursive: true, force: true });
});

const READ = ["--read-access-key-id", "AKIDREAD", "--read-secret-access-key", "readsecret"];

describe("sources store setup", () => {
  it("sets Dosu's sessiondb with --hosted", async () => {
    await dosu("setup", "--hosted");
    expect(calls()).toEqual([
      { method: "GET", path: "/v1/memory/store?deployment_id=dep1" },
      { method: "PUT", path: "/v1/memory/store", body: { deployment_id: "dep1", kind: "hosted" } },
    ]);
    expect(out.join("\n")).toContain("The org's sessions go to Dosu's sessiondb.");
  });

  it("looks at a bucket store first, sends it from flags, and says how to scope member keys", async () => {
    await dosu(
      "setup",
      "--bucket",
      "s3://acme-sessions/agents",
      "--region",
      "eu-west-1",
      "--yes",
      ...READ,
    );
    expect(calls().map((c) => `${c.method} ${c.path}`)).toEqual([
      "GET /v1/memory/store?deployment_id=dep1",
      "POST /v1/memory/sources/detect",
      "PUT /v1/memory/store",
    ]);
    expect(out[0]).toBe(
      "s3://acme-sessions/agents: a sessiondb store (written by dosu-cli/1.0), plus 3 raw files (codex ×2 sampled)",
    );
    expect(put()).toEqual({
      deployment_id: "dep1",
      kind: "bucket",
      bucket_kind: "s3",
      bucket: "acme-sessions",
      prefix: "agents",
      region: "eu-west-1",
      access_key_id: "AKIDREAD",
      secret_access_key: "readsecret",
    });
    expect(out.join("\n")).toContain("owners/<their folder>/");
  });

  it("sends a server store with its token secret from the environment", async () => {
    vi.stubEnv("DOSU_STORE_TOKEN_SECRET", "s3cret");
    vi.stubEnv("DOSU_SOURCE_ACCESS_KEY_ID", "AKIDENV");
    vi.stubEnv("DOSU_SOURCE_SECRET_ACCESS_KEY", "envsecret");
    dosuAnswers((_m, body) =>
      json({
        ...STORE,
        ...body,
        kind: "server",
        server_url: body?.server_url,
        issues_tokens: true,
      }),
    );
    await dosu(
      "setup",
      "--server",
      "https://sessions.acme.test/",
      "--bucket",
      "r2://acme-sessions",
      "--account-id",
      "acct",
      "--json",
    );
    expect(put()).toEqual({
      deployment_id: "dep1",
      kind: "server",
      server_url: "https://sessions.acme.test",
      bucket_kind: "r2",
      bucket: "acme-sessions",
      prefix: "",
      account_id: "acct",
      access_key_id: "AKIDENV",
      secret_access_key: "envsecret",
      token_secret: "s3cret",
    });
    expect(JSON.parse(out.join("\n"))).toMatchObject({ kind: "server", issues_tokens: true });
  });

  it("asks for each answer when no flags are given", async () => {
    script({
      "Where do sessions live?": "server",
      "Server URL": "https://sessions.acme.test",
      "The bucket the server writes: which service?": "s3",
      "The bucket the server writes: name": "acme-sessions/agents",
      "AWS region": "us-east-1",
      "S3-compatible endpoint (blank for AWS)": "https://minio.acme.test",
      "Dosu's read-only keys (GetObject + ListBucket): access key id": "AKIDREAD",
      "Dosu's read-only keys (GetObject + ListBucket): secret access key": "readsecret",
      "The server's SESSIONDB_TOKEN_SECRET, so Dosu signs each member's token (blank: you hand out tokens yourself)":
        "",
    });
    dosuAnswers((_m, body) =>
      json({ ...STORE, ...body, kind: "server", server_url: body?.server_url }),
    );
    await dosu("setup");
    const body = put();
    expect(body).toMatchObject({ kind: "server", endpoint: "https://minio.acme.test" });
    expect(body).not.toHaveProperty("token_secret");
    expect(out.join("\n")).toContain("SESSIONDB_TOKENS");

    const asks = vi.mocked(p.text).mock.calls.map(([opts]) => opts);
    expect(asks[0]?.validate?.("ftp://x")).toContain("https://");
    expect(asks[0]?.validate?.("https://ok.test")).toBeUndefined();
    expect(asks[1]?.validate?.("gs://x")).toContain("bucket[/prefix]");
    expect(asks[1]?.validate?.("s3://ok")).toBeUndefined();
    expect(asks[1]?.validate?.("ok/agents")).toBeUndefined();
  });

  it("asks an r2 bucket for its account, not a region", async () => {
    script({
      "Where do sessions live?": "bucket",
      "Bucket: which service?": "r2",
      "Bucket: name": "acme-sessions/agents",
      "Cloudflare account id": " acct ",
      "Make it the org's session store?": "yes",
    });
    await dosu("setup", ...READ);
    expect(put()).toMatchObject({ bucket_kind: "r2", account_id: "acct" });
    expect(put()).not.toHaveProperty("region");
  });

  it("takes an r2 endpoint instead of an account", async () => {
    await dosu(
      "setup",
      "--bucket",
      "r2://acme-sessions",
      "--endpoint",
      "https://acct.r2.cloudflarestorage.com",
      "--yes",
      ...READ,
    );
    expect(put()).toMatchObject({ endpoint: "https://acct.r2.cloudflarestorage.com" });
    expect(put()).not.toHaveProperty("account_id");
  });

  it("refuses contradictory or half-given flags before calling Dosu", async () => {
    await expect(dosu("setup", "--hosted", "--bucket", "s3://b")).rejects.toThrow(
      "--hosted is Dosu's",
    );
    await expect(dosu("setup", "--bucket", "s3://b", "--read-access-key-id", "x")).rejects.toThrow(
      "go together",
    );
    await expect(
      dosu("setup", "--bucket", "s3://b", "--token-secret", "s", "--yes", ...READ),
    ).rejects.toThrow("only a server store has one");
    await expect(dosu("setup", "--hosted", "--clear-token-secret")).rejects.toThrow(
      "only a server store has one",
    );
    await expect(
      dosu("setup", "--server", "https://s.test", "--token-secret", "s", "--clear-token-secret"),
    ).rejects.toThrow("contradict");
    await expect(dosu("setup", "--bucket", "gs://b", "--yes", ...READ)).rejects.toThrow(
      "not a bucket URL: gs://b",
    );
    await expect(dosu("setup", "--server", "ftp://s", "--yes", ...READ)).rejects.toThrow(
      "not a server URL: ftp://s",
    );
    expect(calls().filter((c) => c.method === "PUT")).toEqual([]);
  });

  it("offers to keep the secret Dosu has for the same server, and clears it only when asked", async () => {
    const current = {
      ...STORE,
      kind: "server",
      server_url: "https://sessions.acme.test",
      issues_tokens: true,
    };
    dosuAnswers((method, body) => json(method === "PUT" ? { ...current, ...body } : current));
    const keep = "The server's SESSIONDB_TOKEN_SECRET (blank: keep the one Dosu has)";
    script({
      "Where do sessions live?": "server",
      "Server URL": "https://sessions.acme.test",
      "The bucket the server writes: which service?": "s3",
      "The bucket the server writes: name": "acme-sessions/agents",
      "AWS region": "us-east-1",
      "S3-compatible endpoint (blank for AWS)": "",
      [keep]: "",
    });
    await dosu("setup", ...READ);
    expect(put()).not.toHaveProperty("token_secret");
    expect(put()).not.toHaveProperty("clear_token_secret");

    fetchImpl.mockClear();
    vi.mocked(p.text).mockClear();
    await dosu(
      "setup",
      "--server",
      "https://sessions.acme.test",
      "--bucket",
      "s3://acme-sessions/agents",
      "--clear-token-secret",
      ...READ,
    );
    expect(put()).toMatchObject({ clear_token_secret: true });
    expect(vi.mocked(p.text).mock.calls.map(([o]) => o.message)).not.toContain(keep);
  });

  it("sets a first store when the org has none, and --json prints only the store", async () => {
    dosuAnswers((method, body) =>
      method === "PUT" ? json({ ...STORE, ...body }) : json({ detail: "no session store" }, 404),
    );
    await dosu(
      "setup",
      "--bucket",
      "s3://acme-sessions/agents",
      "--region",
      "us-east-1",
      "--json",
      ...READ,
    );
    expect(put()).toMatchObject({ kind: "bucket", bucket: "acme-sessions" });
    expect(JSON.parse(out.join("\n"))).toMatchObject({ kind: "bucket", bucket_kind: "s3" });
  });

  it("does not hide a failure to reach Dosu when setting the store", async () => {
    fetchImpl.mockImplementation(async (_url, init) => {
      if (init?.method === "PUT") throw new TypeError("fetch failed");
      return json(STORE);
    });
    await expect(dosu("setup", "--hosted")).rejects.toThrow("fetch failed");
  });

  it("tells a member that only an admin sets the store", async () => {
    dosuAnswers(() => json({ detail: "admins only" }, 403));
    await expect(dosu("setup", "--hosted")).rejects.toThrow(
      "only an org admin can set the org's session store",
    );
    dosuAnswers(() => json({ detail: "bucket refused" }, 422));
    await expect(dosu("setup", "--hosted")).rejects.toThrow("bucket refused");
  });
});

describe("sources store setup: the bucket's raw files", () => {
  it("--agent names their format for Dosu's look and the store, and status shows it", async () => {
    detection = { ...FOUND, agents: { "datadog-trajectory": 3 } };
    await dosu(
      "setup",
      "--bucket",
      "s3://acme-sessions/agents",
      "--agent",
      "datadog-trajectory",
      "--yes",
      ...READ,
    );
    const detect = calls().find((c) => c.path === "/v1/memory/sources/detect");
    expect(detect?.body).toMatchObject({ agent: "datadog-trajectory", bucket: "acme-sessions" });
    expect(put()).toMatchObject({ kind: "bucket", agent: "datadog-trajectory" });
    expect(out.join("\n")).toContain("all read as datadog-trajectory");

    out = [];
    dosuAnswers(() =>
      json({ ...STORE, raw_source_id: "src-raw", raw_agent: "datadog-trajectory" }),
    );
    await dosu("status");
    expect(out.join("\n")).toContain("raw logs other tools drop in it: read as datadog-trajectory");

    out = [];
    dosuAnswers(() => json({ ...STORE, raw_source_id: "src-raw", raw_agent: null }));
    await dosu("status");
    expect(out.join("\n")).toContain(
      "raw logs other tools drop in it: each file's format detected",
    );
  });

  it("interactively, the admin confirms what Dosu found or picks the format, or declines", async () => {
    script({
      "Make it the org's session store?": "agent",
      "Which format are the raw files?": "codex",
      "S3-compatible endpoint (blank for AWS)": "",
    });
    await dosu("setup", "--bucket", "s3://acme-sessions/agents", "--region", "us-east-1", ...READ);
    expect(put()).toMatchObject({ agent: "codex" });

    fetchImpl.mockClear();
    out = [];
    script({
      "Make it the org's session store?": "no",
      "S3-compatible endpoint (blank for AWS)": "",
    });
    await dosu("setup", "--bucket", "s3://acme-sessions/agents", "--region", "us-east-1", ...READ);
    expect(calls().filter((c) => c.method === "PUT")).toEqual([]);
    expect(out.join("\n")).toContain("Cancelled; the org's session store is unchanged.");
  });

  it("refuses --agent for a store that is not a bucket, or a format Dosu does not read", async () => {
    await expect(dosu("setup", "--hosted", "--agent", "codex")).rejects.toThrow(
      "goes with --bucket",
    );
    await expect(
      dosu("setup", "--bucket", "s3://b", "--agent", "notepad", "--yes", ...READ),
    ).rejects.toThrow("--agent must be one of");
    expect(calls().filter((c) => c.method === "PUT")).toEqual([]);
  });

  it("stops before setting a bucket Dosu cannot read with the key", async () => {
    fetchImpl.mockImplementation(async (url, init) =>
      url.endsWith("/detect")
        ? json({ detail: "could not read s3://acme-sessions/agents: AccessDenied" }, 422)
        : json(init?.method === "PUT" ? STORE : STORE),
    );
    await expect(
      dosu("setup", "--bucket", "s3://acme-sessions/agents", "--yes", ...READ),
    ).rejects.toThrow("Dosu could not read s3://acme-sessions/agents with that key");
    expect(calls().filter((c) => c.method === "PUT")).toEqual([]);
  });
});

describe("sources store setup: when Dosu cannot look at the bucket", () => {
  /** Dosu answering each `POST /detect` in turn from `answers`; every other call with the store. */
  function detectAnswers(...answers: Array<() => Response>): void {
    fetchImpl.mockImplementation(async (url, init) => {
      if (url.endsWith("/detect")) return (answers.shift() as () => Response)();
      const body = init?.body ? (JSON.parse(init.body as string) as Record<string, unknown>) : {};
      return json(init?.method === "PUT" ? { ...STORE, ...body } : STORE);
    });
  }
  const BUCKET = ["--bucket", "s3://acme-sessions/agents", "--region", "us-east-1"];
  const detects = () => calls().filter((c) => c.path === "/v1/memory/sources/detect");

  it("says why under --yes: not an admin, Dosu refused, or Dosu unreachable", async () => {
    detectAnswers(() => json({ detail: "admins only" }, 403));
    await expect(dosu("setup", ...BUCKET, "--yes", ...READ)).rejects.toThrow(
      "only an org admin can set the org's session store",
    );
    detectAnswers(() => json({ detail: "busy" }, 503));
    await expect(dosu("setup", ...BUCKET, "--yes", ...READ)).rejects.toThrow(
      "Dosu did not look at the bucket",
    );
    detectAnswers(() => {
      throw new TypeError("fetch failed");
    });
    await expect(dosu("setup", ...BUCKET, "--yes", ...READ)).rejects.toThrow(
      "Could not reach Dosu: fetch failed",
    );
    expect(calls().filter((c) => c.method === "PUT")).toEqual([]);
  });

  it("interactively, takes a different read-only key after a bad one, then sets the store", async () => {
    detectAnswers(
      () => json({ detail: "AccessDenied" }, 422),
      () => json(detection),
    );
    script({
      "S3-compatible endpoint (blank for AWS)": "",
      "What now?": "keys",
      "Dosu's read-only keys (GetObject + ListBucket): access key id": "AKIDREAD2",
      "Dosu's read-only keys (GetObject + ListBucket): secret access key": "readsecret2",
      "Make it the org's session store?": "yes",
    });
    await dosu("setup", ...BUCKET, ...READ);
    expect(detects().map((c) => c.body?.access_key_id)).toEqual(["AKIDREAD", "AKIDREAD2"]);
    expect(put()).toMatchObject({ kind: "bucket", access_key_id: "AKIDREAD2" });
  });

  it("interactively, tries again after Dosu failed, or cancels and sets nothing", async () => {
    detectAnswers(
      () => json({ detail: "busy" }, 503),
      () => json(detection),
    );
    script({
      "S3-compatible endpoint (blank for AWS)": "",
      "What now?": "retry",
      "Make it the org's session store?": "yes",
    });
    await dosu("setup", ...BUCKET, ...READ);
    expect(detects()).toHaveLength(2);
    expect(put()).toMatchObject({ kind: "bucket" });

    fetchImpl.mockClear();
    out = [];
    detectAnswers(() => json({ detail: "busy" }, 503));
    script({ "S3-compatible endpoint (blank for AWS)": "", "What now?": "cancel" });
    await dosu("setup", ...BUCKET, ...READ);
    expect(calls().filter((c) => c.method === "PUT")).toEqual([]);
    expect(out.join("\n")).toContain("Cancelled; the org's session store is unchanged.");
  });

  it("needs a kind of store under --yes", async () => {
    await expect(dosu("setup", "--yes")).rejects.toThrow("say where the org's sessions live");
  });
});

describe("storeApi", () => {
  it("enrolls with the owner only when one is named", async () => {
    const api = storeApi(loadConfig());
    await api?.enroll("james");
    await api?.enroll();
    expect(calls()).toEqual([
      {
        method: "POST",
        path: "/v1/memory/store/enroll",
        body: { deployment_id: "dep1", owner: "james" },
      },
      { method: "POST", path: "/v1/memory/store/enroll", body: { deployment_id: "dep1" } },
    ]);
  });
});

describe("sources store, logged out", () => {
  it("says to log in first", async () => {
    saveConfig(makeTestConfig({ access_token: "t", refresh_token: "r", expires_at: 0 }));
    await expect(dosu("status")).rejects.toThrow("not logged in to Dosu");
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});

describe("sources store status", () => {
  it("shows a member where the store is and their folder", async () => {
    dosuAnswers(() => json({ ...STORE, owner: "james" }));
    await dosu("status");
    const said = out.join("\n");
    expect(said).toContain("the org's bucket s3://acme-sessions/agents");
    expect(said).toContain("members write with their own key");
    expect(said).toContain("You ship as james.");
    expect(calls()).toEqual([{ method: "GET", path: "/v1/memory/store?deployment_id=dep1" }]);
  });

  it("shows an admin who has enrolled", async () => {
    dosuAnswers(() =>
      json({
        ...STORE,
        kind: "server",
        server_url: "https://sessions.acme.test",
        issues_tokens: true,
        members: [
          {
            user_id: "u1",
            owner: "alice",
            source_id: "s1",
            enabled: true,
            last_synced_at: null,
            last_error: null,
          },
          {
            user_id: "u2",
            owner: "bob",
            source_id: "s2",
            enabled: true,
            last_synced_at: new Date().toISOString(),
            last_error: "403",
          },
          {
            user_id: "u3",
            owner: "carol",
            source_id: "s3",
            enabled: false,
            last_synced_at: null,
            last_error: null,
          },
        ],
      }),
    );
    await dosu("status");
    const said = out.join("\n");
    expect(said).toContain("Dosu signs each member's token");
    expect(said).toContain("You have not enrolled.");
    expect(said).toMatch(/alice\s+u1\s+ok\s+never/);
    expect(said).toMatch(/bob\s+u2\s+error/);
    expect(said).toMatch(/carol\s+u3\s+moved/);
  });

  it("says so when no one has enrolled, or the store is the hosted default", async () => {
    dosuAnswers(() =>
      json({ ...STORE, kind: "server", server_url: "https://s.test", url: null, members: [] }),
    );
    await dosu("status");
    expect(out.join("\n")).toContain("members paste a token the admin issued");
    expect(out.join("\n")).toContain("No one has enrolled yet.");

    out = [];
    dosuAnswers(() =>
      json({ ...STORE, kind: "hosted", configured: false, url: null, issues_tokens: true }),
    );
    await dosu("status", "--json");
    expect(JSON.parse(out.join("\n"))).toMatchObject({ configured: false });
    out = [];
    await dosu("status");
    expect(out.join("\n")).toContain("(the default; no admin has set one)");
  });

  it("says how to set one when the org has none", async () => {
    dosuAnswers(() => json({ detail: "none" }, 404));
    await expect(dosu("status")).rejects.toThrow("dosu sources store setup");
    dosuAnswers(() => json({ detail: "down" }, 500));
    await expect(dosu("status")).rejects.toThrow("down");
  });
});

describe("sources store join", () => {
  const ENROLLED = { source: { id: "src-1" } };

  it("hands the flags to joinOrgStore and reports the folder", async () => {
    vi.mocked(joinOrgStore).mockResolvedValueOnce({
      target: {
        kind: "bucket",
        name: "org",
        url: STORE.url as string,
        owner: "james",
        access_key_id: "AKIDW",
        secret_access_key: "w",
      },
      enrollment: ENROLLED,
    } as never);
    await dosu(
      "join",
      "--owner",
      "james",
      "--write-access-key-id",
      "AKIDW",
      "--write-secret-access-key",
      "w",
      "--name",
      "acme",
      "--no-default",
      "--yes",
    );
    expect(vi.mocked(joinOrgStore).mock.calls[0]?.[3]).toEqual({
      owner: "james",
      write: { access_key_id: "AKIDW", secret_access_key: "w" },
      name: "acme",
      makeDefault: false,
      yes: true,
    });
    expect(out.join("\n")).toContain(
      "Sessions ship to the org's bucket s3://acme-sessions/agents as james.",
    );
  });

  it("never prints a token or key under --json", async () => {
    vi.mocked(joinOrgStore)
      .mockResolvedValueOnce({
        target: { name: "org", url: "https://s.test", owner: "alice", token: "sdb_secret" },
        enrollment: ENROLLED,
      } as never)
      .mockResolvedValueOnce({
        target: {
          kind: "bucket",
          name: "org",
          url: "s3://b",
          owner: "james",
          access_key_id: "AKIDW",
          secret_access_key: "w",
        },
        enrollment: ENROLLED,
      } as never);
    await dosu("join", "--token", "sdb_secret", "--json");
    expect(vi.mocked(joinOrgStore).mock.calls[0]?.[3]).toEqual({ token: "sdb_secret", yes: true });
    await dosu("join", "--json");
    const said = out.join("\n");
    expect(said).not.toContain("sdb_secret");
    expect(said).not.toContain('"w"');
    expect(said).toContain('"src-1"');
  });

  it("saves nothing when cancelled", async () => {
    vi.mocked(joinOrgStore).mockResolvedValueOnce(null);
    await dosu("join");
    expect(vi.mocked(joinOrgStore).mock.calls[0]?.[3]).toEqual({});
    expect(out.join("\n")).toContain("Cancelled; nothing saved.");
  });

  it("refuses half a key pair, and an org without a store", async () => {
    await expect(dosu("join", "--write-access-key-id", "x")).rejects.toThrow("go together");
    dosuAnswers(() => json({ detail: "none" }, 404));
    await expect(dosu("join")).rejects.toThrow("dosu sources store setup");
    dosuAnswers(() => json({ detail: "down" }, 500));
    await expect(dosu("join")).rejects.toThrow("down");
    expect(joinOrgStore).not.toHaveBeenCalled();
  });
});
