/** The bucket wizard: answers from flags skip their prompts, the write probe gates saving,
 * the saved target becomes the default, and Dosu is asked to read it with the right keys. */

import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CliUsageError } from "../cli/errors";
import { loadConfig, saveConfig } from "../config/config";
import { makeTestConfig } from "../config/config.test-utils";
import * as p from "../tui/prompts";
import type { SourceStatus } from "./api";
import { defaultOwner, inferProvider, runBucketWizard, targetUrl } from "./wizard";

vi.mock("../tui/prompts", () => ({
  text: vi.fn(),
  select: vi.fn(),
  confirm: vi.fn(),
  isCancel: (value: unknown) => value === CANCEL,
  spinner: vi.fn(() => ({ start: vi.fn(), stop: vi.fn(), message: vi.fn() })),
  log: { success: vi.fn(), error: vi.fn(), warn: vi.fn(), info: vi.fn(), message: vi.fn() },
}));

const CANCEL = Symbol("cancel");

const store = vi.hoisted(() => ({
  put: vi.fn(async () => {}),
  get: vi.fn(async () => null as Uint8Array | null),
  url: "s3://acme-sessions/dosu",
}));
vi.mock("../config/targets", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../config/targets")>()),
  openStore: vi.fn(() => store),
}));

const probe = vi.hoisted(() => ({
  ensureLayout: vi.fn(async () => ({ created_by: "dosu-cli/test" })),
  probe: vi.fn(async () => {}),
}));
vi.mock("@dosu/sessionstorage", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@dosu/sessionstorage")>()),
  ensureLayout: probe.ensureLayout,
  probe: probe.probe,
}));

let home: string;
type Fetch = (input: string, init?: RequestInit) => Promise<Response>;
let fetchImpl: ReturnType<typeof vi.fn<Fetch>>;

function connected(extra: Partial<SourceStatus> = {}): SourceStatus {
  return {
    id: "11111111-1111-4111-8111-111111111111",
    name: "s3",
    org: "org1",
    deployment_id: "dep1",
    kind: "s3",
    bucket: "acme-sessions",
    prefix: "dosu",
    owner: "james",
    url: "s3://acme-sessions/dosu",
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

/** Script the prompts: each call takes the next scripted answer for its message. */
function script(answers: Record<string, unknown>): void {
  const answer = async (opts: { message: string }) => {
    if (!(opts.message in answers)) throw new Error(`unscripted prompt: ${opts.message}`);
    return answers[opts.message];
  };
  vi.mocked(p.text).mockImplementation(answer as typeof p.text);
  vi.mocked(p.select).mockImplementation(answer as typeof p.select);
  vi.mocked(p.confirm).mockImplementation(answer as typeof p.confirm);
}

/** Everything logged at a level, with the line wrapping undone. */
function logged(level: keyof typeof p.log): string {
  return vi
    .mocked(p.log[level])
    .mock.calls.map(([message]) => message)
    .join(" ")
    .replace(/\s+/g, " ");
}

function asked(): string[] {
  return [p.text, p.select, p.confirm].flatMap((fn) =>
    vi.mocked(fn).mock.calls.map(([opts]) => (opts as { message: string }).message),
  );
}

/** The connect calls (POSTs) made so far, as [url, parsed body]. */
function connects(): [string, Record<string, unknown>][] {
  return fetchImpl.mock.calls
    .filter(([, init]) => init?.method === "POST")
    .map(([url, init]) => [url, JSON.parse((init as RequestInit).body as string)]);
}

const FLAGS = {
  provider: "s3" as const,
  bucket: "acme-sessions",
  prefix: "dosu",
  owner: "james",
  region: "us-east-1",
  write: { access_key_id: "AKIAWRITE", secret_access_key: "writesecret" },
};

beforeEach(() => {
  home = realpathSync(mkdtempSync(join(tmpdir(), "dosu-wizard-")));
  vi.stubEnv("HOME", home);
  vi.stubEnv("XDG_CONFIG_HOME", join(home, ".config"));
  vi.stubEnv("DOSU_DEV", undefined);
  vi.stubEnv("DOSU_BACKEND_URL_OVERRIDE", "https://api.dosu.test");
  for (const name of [
    "AWS_ACCESS_KEY_ID",
    "AWS_SECRET_ACCESS_KEY",
    "AWS_PROFILE",
    "AWS_REGION",
    "R2_ACCOUNT_ID",
    "R2_ACCESS_KEY_ID",
    "DOSU_SOURCE_ACCESS_KEY_ID",
    "DOSU_SOURCE_SECRET_ACCESS_KEY",
  ]) {
    vi.stubEnv(name, undefined);
  }
  fetchImpl = vi.fn<Fetch>(async (_url, init) =>
    init?.method === "POST"
      ? new Response(JSON.stringify(connected()), { status: 200 })
      : new Response(JSON.stringify({ sources: [] }), { status: 200 }),
  );
  vi.stubGlobal("fetch", fetchImpl);
  vi.mocked(p.text).mockReset();
  vi.mocked(p.select).mockReset();
  vi.mocked(p.confirm).mockReset();
  for (const fn of Object.values(p.log)) vi.mocked(fn).mockReset();
  probe.probe.mockReset().mockResolvedValue(undefined);
  probe.ensureLayout.mockReset().mockResolvedValue({ created_by: "dosu-cli/test" });
  configure();
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  rmSync(home, { recursive: true, force: true });
});

describe("the whole flow with --yes", () => {
  it("probes the bucket, saves the target as the default, and connects it with the same keys", async () => {
    const result = await runBucketWizard(loadConfig(), { ...FLAGS, read: "same", yes: true });

    expect(asked()).toEqual([]);
    expect(probe.ensureLayout).toHaveBeenCalledWith(store, expect.stringMatching(/^dosu-cli\//));
    expect(probe.probe).toHaveBeenCalledWith(store, "james");
    expect(result?.source?.id).toBe(connected().id);

    const cfg = loadConfig();
    expect(cfg.default_target).toBe("s3");
    expect(cfg.targets).toEqual([
      {
        name: "s3",
        url: "s3://acme-sessions/dosu",
        owner: "james",
        region: "us-east-1",
        credentials: FLAGS.write,
        source_id: connected().id,
      },
    ]);
    const [url, body] = connects()[0] as [string, Record<string, unknown>];
    expect(url).toBe("https://api.dosu.test/v1/memory/sources");
    expect(body).toEqual({
      deployment_id: "dep1",
      kind: "s3",
      bucket: "acme-sessions",
      prefix: "dosu",
      owner: "james",
      region: "us-east-1",
      access_key_id: "AKIAWRITE",
      secret_access_key: "writesecret",
      name: "s3",
    });
  });

  it("refuses to ask for anything it was not given", async () => {
    await expect(
      runBucketWizard(loadConfig(), { ...FLAGS, bucket: undefined, yes: true }),
    ).rejects.toThrow(/--yes: Bucket name was not given/);
    expect(loadConfig().targets ?? []).toEqual([]);
  });

  it("cannot hand Dosu this machine's environment as keys", async () => {
    await expect(
      runBucketWizard(loadConfig(), { ...FLAGS, write: "env", read: "same", yes: true }),
    ).rejects.toThrow(CliUsageError);
    // The target is saved before the keys question; the connect is what failed.
    expect(loadConfig().targets?.[0]?.credentials).toBe("env");
  });

  it("takes DOSU_SOURCE_* as the read keys without asking", async () => {
    vi.stubEnv("DOSU_SOURCE_ACCESS_KEY_ID", "AKIAREAD");
    vi.stubEnv("DOSU_SOURCE_SECRET_ACCESS_KEY", "readsecret");
    await runBucketWizard(loadConfig(), { ...FLAGS, write: "env", yes: true });
    const body = connects()[0]?.[1] as Record<string, string>;
    expect(body.access_key_id).toBe("AKIAREAD");
    expect(body.secret_access_key).toBe("readsecret");
  });
});

describe("prompting", () => {
  it("asks only for what flags left out, in order, with the login's email as the owner", async () => {
    configure();
    const cfg = loadConfig();
    script({
      "Where do you keep your sessions?": "r2",
      "Bucket name": "team-sessions",
      "Prefix inside the bucket": "dosu",
      "Cloudflare account id": "0123456789abcdef0123456789abcdef",
      "Owner id (your sessions land under owners/<id>/)": "james",
      "Keys this machine uploads with": "enter",
      "Upload keys: access key id": "R2WRITE",
      "Upload keys: secret access key": "r2secret",
      "Ship finished sessions there instead of to Dosu?": true,
      "Let Dosu read the bucket and learn from the sessions in it?": true,
      "Keys Dosu reads the bucket with": "enter",
      "Read-only keys: access key id": "R2READ",
      "Read-only keys: secret access key": "r2readsecret",
    });

    const result = await runBucketWizard(cfg);

    expect(result?.target).toMatchObject({
      name: "r2",
      url: "r2://team-sessions/dosu",
      owner: "james",
      account_id: "0123456789abcdef0123456789abcdef",
      credentials: { access_key_id: "R2WRITE", secret_access_key: "r2secret" },
    });
    expect(asked()).toContain("Keys Dosu reads the bucket with");
    const body = connects()[0]?.[1] as Record<string, string>;
    expect(body).toMatchObject({
      kind: "r2",
      access_key_id: "R2READ",
      secret_access_key: "r2readsecret",
    });
    // The owner prompt was seeded from the login.
    const ownerPrompt = vi
      .mocked(p.text)
      .mock.calls.find(([o]) => o.message.startsWith("Owner id"))?.[0];
    expect(ownerPrompt?.initialValue).toBe(defaultOwner(cfg));
  });

  it("skips the storage questions a flag answered and the keys question when the environment has them", async () => {
    vi.stubEnv("AWS_ACCESS_KEY_ID", "AKIAENV");
    vi.stubEnv("AWS_SECRET_ACCESS_KEY", "envsecret");
    script({
      "Prefix inside the bucket": "dosu",
      "Owner id (your sessions land under owners/<id>/)": "james",
      "Keys this machine uploads with": "env",
      "Ship finished sessions there instead of to Dosu?": false,
      "Let Dosu read the bucket and learn from the sessions in it?": false,
    });

    const result = await runBucketWizard(loadConfig(), {
      provider: "s3",
      bucket: "acme-sessions",
      region: "eu-west-1",
    });

    expect(asked()).not.toContain("Where do you keep your sessions?");
    expect(asked()).not.toContain("Bucket name");
    expect(asked()).not.toContain("AWS region");
    expect(result?.source).toBeUndefined();
    expect(result?.target.credentials).toBe("env");
    expect(loadConfig().default_target).toBeUndefined();
    expect(connects()).toEqual([]);
  });

  it("returns null when a prompt is cancelled, saving nothing", async () => {
    vi.mocked(p.select).mockResolvedValue(CANCEL);
    expect(await runBucketWizard(loadConfig())).toBeNull();
    expect(loadConfig().targets ?? []).toEqual([]);
  });
});

describe("the write probe", () => {
  it("with --yes stops with the store's error and a hint, saving nothing", async () => {
    probe.probe.mockRejectedValue(new Error("AccessDenied: PutObject"));
    await expect(runBucketWizard(loadConfig(), { ...FLAGS, yes: true })).rejects.toThrow(
      /AccessDenied: PutObject[\s\S]*region and keys/,
    );
    expect(loadConfig().targets ?? []).toEqual([]);
    expect(connects()).toEqual([]);
  });

  it("interactively offers to re-enter the keys, and probes again with them", async () => {
    probe.probe
      .mockRejectedValueOnce(new Error("SignatureDoesNotMatch"))
      .mockResolvedValueOnce(undefined);
    script({
      "What now?": "keys",
      "Keys this machine uploads with": "enter",
      "Upload keys: access key id": "AKIAFIXED",
      "Upload keys: secret access key": "fixedsecret",
      "Ship finished sessions there instead of to Dosu?": true,
      "Let Dosu read the bucket and learn from the sessions in it?": false,
    });

    const result = await runBucketWizard(loadConfig(), FLAGS);

    expect(logged("error")).toContain("SignatureDoesNotMatch");
    expect(probe.probe).toHaveBeenCalledTimes(2);
    expect(result?.target.credentials).toEqual({
      access_key_id: "AKIAFIXED",
      secret_access_key: "fixedsecret",
    });
  });

  it("interactively tries again with the same details", async () => {
    probe.probe.mockRejectedValueOnce(new Error("timeout")).mockResolvedValueOnce(undefined);
    script({
      "What now?": "retry",
      "Ship finished sessions there instead of to Dosu?": true,
      "Let Dosu read the bucket and learn from the sessions in it?": false,
    });

    const result = await runBucketWizard(loadConfig(), FLAGS);

    expect(probe.probe).toHaveBeenCalledTimes(2);
    expect(result?.target.credentials).toEqual(FLAGS.write);
    expect(asked()).not.toContain("Keys this machine uploads with");
  });

  it("starts over with the earlier answers as defaults and the keys kept", async () => {
    probe.probe.mockRejectedValueOnce(new Error("NoSuchBucket")).mockResolvedValueOnce(undefined);
    let bucketPrompts = 0;
    script({
      "What now?": "restart",
      "Where do you keep your sessions?": "s3",
      "Bucket name": "acme-sessions-fixed",
      "Prefix inside the bucket": "dosu",
      "AWS region": "us-east-1",
      "Owner id (your sessions land under owners/<id>/)": "james",
      "Ship finished sessions there instead of to Dosu?": true,
      "Let Dosu read the bucket and learn from the sessions in it?": false,
    });
    vi.mocked(p.text).mockImplementation(async (opts) => {
      if (opts.message === "Bucket name") {
        bucketPrompts++;
        // First pass: nothing to seed. Second pass: the earlier answer is the default.
        expect(opts.initialValue).toBe(bucketPrompts === 1 ? undefined : "acme-sessions-typo");
        return bucketPrompts === 1 ? "acme-sessions-typo" : "acme-sessions-fixed";
      }
      const answers: Record<string, string> = {
        "Prefix inside the bucket": "dosu",
        "AWS region": "us-east-1",
        "Owner id (your sessions land under owners/<id>/)": "james",
      };
      return answers[opts.message] ?? "";
    });

    const result = await runBucketWizard(loadConfig(), {
      write: FLAGS.write,
      prefix: "dosu",
      owner: "james",
      region: "us-east-1",
    });

    expect(bucketPrompts).toBe(2);
    expect(result?.target.url).toBe("s3://acme-sessions-fixed/dosu");
    expect(result?.target.credentials).toEqual(FLAGS.write);
    expect(asked().filter((m) => m === "Keys this machine uploads with")).toHaveLength(0);
  });

  it("cancelling at the failure saves nothing", async () => {
    probe.probe.mockRejectedValue(new Error("AccessDenied"));
    script({ "What now?": "cancel" });
    expect(await runBucketWizard(loadConfig(), FLAGS)).toBeNull();
    expect(loadConfig().targets ?? []).toEqual([]);
  });
});

describe("connecting", () => {
  it("interactively offers other keys for Dosu first when Dosu could not read with them", async () => {
    const answers = [
      new Response(JSON.stringify({ detail: "could not list owners/james/changes/" }), {
        status: 422,
      }),
      new Response(JSON.stringify(connected()), { status: 200 }),
    ];
    fetchImpl.mockImplementation(async (_url, init) =>
      init?.method === "POST"
        ? (answers.shift() as Response)
        : new Response(JSON.stringify({ sources: [] }), { status: 200 }),
    );
    script({
      "Ship finished sessions there instead of to Dosu?": true,
      "Let Dosu read the bucket and learn from the sessions in it?": true,
      "Keys Dosu reads the bucket with": "same",
      "What now?": "keys",
      "Read-only keys: access key id": "AKIAREAD2",
      "Read-only keys: secret access key": "read2secret",
    });

    const result = await runBucketWizard(loadConfig(), FLAGS);

    expect(result?.source?.id).toBe(connected().id);
    expect(connects()).toHaveLength(2);
    expect((connects()[1]?.[1] as Record<string, string>).access_key_id).toBe("AKIAREAD2");
    const whatNow = vi.mocked(p.select).mock.calls.find(([o]) => o.message === "What now?")?.[0];
    expect(whatNow?.options[0]?.value).toBe("keys");
    expect(loadConfig().targets?.[0]?.source_id).toBe(connected().id);
  });

  it("interactively tries again first for any other failure, and skipping keeps the target", async () => {
    fetchImpl.mockImplementation(async (_url, init) =>
      init?.method === "POST"
        ? new Response("", { status: 404 })
        : new Response(JSON.stringify({ sources: [] }), { status: 200 }),
    );
    const answers: Record<string, unknown[]> = { "What now?": ["retry", "skip"] };
    script({
      "Ship finished sessions there instead of to Dosu?": true,
      "Let Dosu read the bucket and learn from the sessions in it?": true,
      "Keys Dosu reads the bucket with": "same",
    });
    vi.mocked(p.select).mockImplementation((async (opts: { message: string }) => {
      if (opts.message === "What now?") return answers["What now?"]?.shift();
      return "same";
    }) as typeof p.select);

    const result = await runBucketWizard(loadConfig(), FLAGS);

    expect(result?.source).toBeUndefined();
    expect(result?.connectError).toMatch(/did not accept the source/);
    expect(connects()).toHaveLength(2);
    const whatNow = vi.mocked(p.select).mock.calls.find(([o]) => o.message === "What now?")?.[0];
    expect(whatNow?.options[0]?.value).toBe("retry");
    expect(loadConfig().targets?.[0]).toMatchObject({ name: "s3" });
    expect(logged("warn")).toContain("dosu sources connect --target s3");
  });

  it("with --yes keeps the saved target and reports why when Dosu cannot read the bucket", async () => {
    fetchImpl.mockImplementation(async (_url, init) =>
      init?.method === "POST"
        ? new Response(JSON.stringify({ detail: "could not list owners/james/changes/" }), {
            status: 422,
          })
        : new Response(JSON.stringify({ sources: [] }), { status: 200 }),
    );
    const result = await runBucketWizard(loadConfig(), { ...FLAGS, read: "same", yes: true });
    expect(result?.source).toBeUndefined();
    expect(result?.connectError).toMatch(
      /could not read s3:\/\/acme-sessions\/dosu as owner james/,
    );
    expect(loadConfig().targets?.[0]).toMatchObject({ name: "s3" });
    expect(loadConfig().targets?.[0]?.source_id).toBeUndefined();
    expect(logged("warn")).toContain("dosu sources connect --target s3");
  });

  it("leaves the bucket an archive when not logged in", async () => {
    configure(false);
    const result = await runBucketWizard(loadConfig(), { ...FLAGS, yes: true });
    expect(result?.source).toBeUndefined();
    expect(fetchImpl).not.toHaveBeenCalled();
    expect(loadConfig().default_target).toBe("s3");
  });
});

describe("the Dosu preflight", () => {
  it("runs before any bucket question and says which Dosu is ready", async () => {
    await runBucketWizard(loadConfig(), { ...FLAGS, read: "same", yes: true });
    const [url, init] = fetchImpl.mock.calls[0] as [string, RequestInit];
    expect(init.method).toBe("GET");
    expect(url).toBe("https://api.dosu.test/v1/memory/sources?deployment_id=dep1");
  });

  it("reports a Dosu without the sources API up front, with its URL; the bucket can still be set up", async () => {
    fetchImpl.mockImplementation(async () => new Response("", { status: 404 }));
    script({
      "What now?": "continue",
      "Ship finished sessions there instead of to Dosu?": true,
    });

    const result = await runBucketWizard(loadConfig(), FLAGS);

    const warned = logged("warn");
    expect(warned).toContain("Dosu at https://api.dosu.test has no session sources API (HTTP 404)");
    expect(asked()[0]).toBe("What now?");
    expect(asked()).not.toContain("Let Dosu read the bucket and learn from the sessions in it?");
    expect(connects()).toEqual([]);
    expect(result?.source).toBeUndefined();
    expect(result?.connectError).toMatch(/HTTP 404/);
    expect(loadConfig().default_target).toBe("s3");
  });

  it("reports an unreachable Dosu the same way", async () => {
    fetchImpl.mockRejectedValue(new TypeError("fetch failed"));
    script({ "What now?": "cancel" });

    expect(await runBucketWizard(loadConfig(), FLAGS)).toBeNull();

    expect(logged("warn")).toContain("Could not reach Dosu at https://api.dosu.test: fetch failed");
    expect(loadConfig().targets ?? []).toEqual([]);
  });

  it("with --yes warns, sets the bucket up, and skips the connect", async () => {
    fetchImpl.mockImplementation(async () => new Response("", { status: 503 }));
    const result = await runBucketWizard(loadConfig(), { ...FLAGS, read: "same", yes: true });
    expect(asked()).toEqual([]);
    expect(connects()).toEqual([]);
    expect(result?.connectError).toMatch(/HTTP 503/);
    expect(loadConfig().default_target).toBe("s3");
  });

  it("is skipped when Dosu was not asked for", async () => {
    await runBucketWizard(loadConfig(), { ...FLAGS, connect: false, yes: true });
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});

describe("helpers", () => {
  it("builds the target URL by provider", () => {
    expect(targetUrl("s3", "b", "p/")).toBe("s3://b/p");
    expect(targetUrl("compatible", "b", "")).toBe("s3://b");
    expect(targetUrl("r2", "b", "/x/y/")).toBe("r2://b/x/y");
  });

  it("infers the provider from what was given", () => {
    expect(inferProvider({})).toBeUndefined();
    expect(inferProvider({ endpoint: "http://localhost:9000" })).toBe("compatible");
    expect(inferProvider({ accountId: "abc" })).toBe("r2");
    expect(inferProvider({ region: "us-east-1" })).toBe("s3");
    expect(inferProvider({ provider: "r2", region: "x" })).toBe("r2");
  });
});
