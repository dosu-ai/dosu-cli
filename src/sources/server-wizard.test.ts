/** The server wizard: the token is checked against the server, the bucket behind it is
 * learned, the target is saved with the token, and Dosu is asked to read the server's bucket
 * with its own keys. */

import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CliUsageError } from "../cli/errors";
import { loadConfig, saveConfig } from "../config/config";
import { makeTestConfig } from "../config/config.test-utils";
import * as p from "../tui/prompts";
import { bucketOfStorage } from "./connect";
import { bucketOfTarget, normalizeServerUrl, runServerWizard } from "./server-wizard";

vi.mock("../tui/prompts", () => ({
  text: vi.fn(),
  select: vi.fn(),
  confirm: vi.fn(),
  isCancel: (value: unknown) => value === CANCEL,
  spinner: vi.fn(() => ({ start: vi.fn(), stop: vi.fn(), message: vi.fn() })),
  log: { success: vi.fn(), error: vi.fn(), warn: vi.fn(), info: vi.fn(), message: vi.fn() },
}));

const CANCEL = Symbol("cancel");
const SERVER = "https://sessions.example.com";
const TOKEN = "sdb_test_token";

type Fetch = (input: string, init?: RequestInit) => Promise<Response>;
let home: string;

/** The sessiondb server and the Dosu backend behind one fetch. */
interface World {
  storage: Record<string, unknown>;
  dosuSources: Record<string, unknown>[];
  calls: { url: string; init?: RequestInit }[];
}

function world(overrides: Partial<World> = {}): World & { fetch: Fetch } {
  const w: World = {
    storage: { url: "r2://acme-sessions/dosu", account_id: "acct" },
    dosuSources: [],
    calls: [],
    ...overrides,
  };
  const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });
  const fetch: Fetch = async (url, init) => {
    w.calls.push({ url, init });
    const auth = new Headers(init?.headers).get("authorization");
    if (url.startsWith(SERVER)) {
      if (auth !== `Bearer ${TOKEN}`) {
        return json({ error: { code: "unauthorized", message: "nope" } }, 401);
      }
      if (url.endsWith("/v1/me")) return json({ owner: "acme", storage: w.storage });
      return json({ error: { code: "not_found" } }, 404);
    }
    // Dosu's sources API.
    if (init?.method === "POST") {
      const body = JSON.parse(init.body as string) as Record<string, unknown>;
      const source = {
        id: "src-1",
        name: body.name,
        url: `${body.kind}://${body.bucket}/${body.prefix}`,
        owner: body.owner,
      };
      w.dosuSources.push(source);
      return json(source);
    }
    return json({ sources: w.dosuSources });
  };
  return {
    ...w,
    fetch,
    get calls() {
      return w.calls;
    },
  } as World & { fetch: Fetch };
}

function script(answers: Record<string, unknown>): void {
  const answer = async (opts: { message: string }) => {
    if (!(opts.message in answers)) throw new Error(`unscripted prompt: ${opts.message}`);
    const value = answers[opts.message];
    return Array.isArray(value) ? value.shift() : value;
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

beforeEach(() => {
  home = realpathSync(mkdtempSync(join(tmpdir(), "dosu-server-wizard-")));
  vi.stubEnv("HOME", home);
  vi.stubEnv("XDG_CONFIG_HOME", join(home, ".config"));
  vi.stubEnv("DOSU_DEV", undefined);
  vi.stubEnv("DOSU_BACKEND_URL_OVERRIDE", "https://api.dosu.test");
  vi.stubEnv("DOSU_SOURCE_ACCESS_KEY_ID", undefined);
  vi.stubEnv("DOSU_SOURCE_SECRET_ACCESS_KEY", undefined);
  for (const fn of [p.text, p.select, p.confirm]) vi.mocked(fn).mockReset();
  for (const fn of Object.values(p.log)) vi.mocked(fn).mockReset();
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
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  rmSync(home, { recursive: true, force: true });
});

describe("helpers", () => {
  it("normalizes server URLs", () => {
    expect(normalizeServerUrl(" https://s.example.com/ ")).toBe("https://s.example.com");
    expect(normalizeServerUrl("http://localhost:7200")).toBe("http://localhost:7200");
    expect(normalizeServerUrl("s3://bucket")).toBeUndefined();
    expect(normalizeServerUrl("example.com")).toBeUndefined();
  });

  it("reads the bucket out of a storage view", () => {
    expect(bucketOfStorage({ url: "r2://b/p/q" })).toEqual({
      provider: "r2",
      bucket: "b",
      prefix: "p/q",
    });
    expect(bucketOfStorage({ url: "s3://b", endpoint: "http://minio:9000" })).toEqual({
      provider: "compatible",
      bucket: "b",
      prefix: "",
    });
    expect(bucketOfStorage({ url: "file:///srv/sessions" })).toBeUndefined();
  });
});

describe("runServerWizard", () => {
  it("with everything given: checks the token, saves the target as default, connects the server's bucket to Dosu", async () => {
    const w = world();
    vi.stubGlobal("fetch", w.fetch);
    script({
      "Let Dosu read the bucket and learn from the sessions in it?": true,
      "Read-only keys: access key id": "AKIAREAD",
      "Read-only keys: secret access key": "readsecret",
    });

    const result = await runServerWizard(
      loadConfig(),
      { server: `${SERVER}/`, token: TOKEN, name: "team" },
      {},
      w.fetch,
    );

    expect(result?.target).toEqual({
      name: "team",
      url: SERVER,
      owner: "acme",
      token: TOKEN,
      source_id: "src-1",
    });
    expect(result?.source).toMatchObject({ url: "r2://acme-sessions/dosu", owner: "acme" });
    const cfg = loadConfig();
    expect(cfg.default_target).toBe("team");
    expect(cfg.targets).toEqual([expect.objectContaining({ name: "team", token: TOKEN })]);
    // Dosu was told about the bucket the server reported, with the read keys, not the token.
    const connect = w.calls.find((c) => c.init?.method === "POST");
    expect(JSON.parse(connect?.init?.body as string)).toMatchObject({
      kind: "r2",
      bucket: "acme-sessions",
      prefix: "dosu",
      owner: "acme",
      account_id: "acct",
      access_key_id: "AKIAREAD",
      secret_access_key: "readsecret",
      name: "team",
    });
    expect(JSON.stringify(connect?.init?.body)).not.toContain(TOKEN);
    // Nothing about the bucket or its write keys was asked: the server holds those.
    expect(asked()).toEqual([
      "Read-only keys: access key id",
      "Read-only keys: secret access key",
      "Let Dosu read the bucket and learn from the sessions in it?",
    ]);
  });

  it("re-asks for the token when the server rejects it, and cancels cleanly", async () => {
    const w = world();
    script({
      "Server URL": SERVER,
      Token: ["sdb_wrong", TOKEN],
      "What now?": "token",
      "Name for this target": "server",
      "Let Dosu read the bucket and learn from the sessions in it?": false,
    });

    const result = await runServerWizard(loadConfig(), {}, {}, w.fetch);

    expect(result?.target).toMatchObject({ url: SERVER, owner: "acme", token: TOKEN });
    // The only server is where sessions ship, without asking.
    expect(loadConfig().default_target).toBe("server");
    expect(asked().filter((m) => m === "Token")).toHaveLength(2);
    expect(result?.source).toBeUndefined();

    // Cancelling at the retry prompt saves nothing.
    const w2 = world();
    script({ "Server URL": SERVER, Token: "sdb_wrong", "What now?": "cancel" });
    const cfgBefore = loadConfig();
    expect(await runServerWizard(cfgBefore, {}, {}, w2.fetch)).toBeNull();
  });

  it("retries an unreachable server, or lets the URL be changed", async () => {
    const w = world();
    let wrongCalls = 0;
    const flaky: Fetch = async (url, init) => {
      if (url.startsWith("https://wrong.example.com")) {
        wrongCalls += 1;
        if (wrongCalls === 1) throw new Error("ECONNREFUSED");
        return new Response("gateway", { status: 502 });
      }
      return w.fetch(url, init);
    };
    script({
      "Server URL": ["https://wrong.example.com", SERVER],
      Token: TOKEN,
      "What now?": ["retry", "url"],
      "Name for this target": "server",
      "Let Dosu read the bucket and learn from the sessions in it?": false,
    });
    const result = await runServerWizard(loadConfig(), {}, {}, flaky);
    expect(result?.target).toMatchObject({ url: SERVER, owner: "acme" });
    expect(wrongCalls).toBe(2);
    expect(logged("error")).toContain("cannot reach https://wrong.example.com");
    expect(logged("error")).toContain("https://wrong.example.com answered HTTP 502");
  });

  it("rejects a malformed --server under --yes, keeps a folder-backed server as archive only, and carries a source id over", async () => {
    await expect(
      runServerWizard(
        loadConfig(),
        { server: "not a url", token: TOKEN, yes: true },
        {},
        world().fetch,
      ),
    ).rejects.toThrow(/not a server URL/);

    const folder = world({ storage: { url: "file:///srv/sessions" } });
    const cfg = loadConfig();
    cfg.targets = [
      { name: "team", url: SERVER, owner: "acme", token: "old", source_id: "src-old" },
    ];
    saveConfig(cfg);
    const result = await runServerWizard(
      loadConfig(),
      { server: SERVER, token: TOKEN, name: "team", yes: true },
      {},
      folder.fetch,
    );
    expect(result).toEqual({
      target: { name: "team", url: SERVER, owner: "acme", token: TOKEN, source_id: "src-old" },
    });
    expect(logged("info")).toContain("folder on the server");
  });

  it("refuses a bad token under --yes instead of prompting", async () => {
    const w = world();
    await expect(
      runServerWizard(loadConfig(), { server: SERVER, token: "sdb_wrong", yes: true }, {}, w.fetch),
    ).rejects.toThrow(CliUsageError);
    expect(asked()).toEqual([]);
  });
});

describe("bucketOfTarget", () => {
  it("asks a server target for its bucket and reads a bucket target's own fields", async () => {
    const w = world();
    expect(
      await bucketOfTarget({ name: "team", url: SERVER, owner: "acme", token: TOKEN }, w.fetch),
    ).toEqual({
      url: "r2://acme-sessions/dosu",
      scheme: "r2",
      bucket: "acme-sessions",
      prefix: "dosu",
      account_id: "acct",
    });
    await expect(
      bucketOfTarget(
        { name: "team", url: SERVER, owner: "acme", token: "sdb_wrong" },
        world().fetch,
      ),
    ).rejects.toThrow(/answered/);
  });
});
