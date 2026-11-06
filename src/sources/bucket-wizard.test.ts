/** The bucket wizard: the write key is checked by writing the bucket, the target is saved with
 * it, and Dosu is asked to read the bucket with its own, separate keys. */

import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CliUsageError } from "../cli/errors";
import { loadConfig, saveConfig } from "../config/config";
import { makeTestConfig } from "../config/config.test-utils";
import { type FakeS3, fakeS3 } from "../shipper/fake-s3.test-utils";
import * as p from "../tui/prompts";
import { defaultOwner, normalizeBucketUrl, runBucketWizard } from "./bucket-wizard";

vi.mock("../tui/prompts", () => ({
  text: vi.fn(),
  select: vi.fn(),
  confirm: vi.fn(),
  isCancel: (value: unknown) => value === CANCEL,
  spinner: vi.fn(() => ({ start: vi.fn(), stop: vi.fn(), message: vi.fn() })),
  log: { success: vi.fn(), error: vi.fn(), warn: vi.fn(), info: vi.fn(), message: vi.fn() },
}));

const CANCEL = Symbol("cancel");
const ENDPOINT = "http://s3.test:9000";
const WRITE = { access_key_id: "AKIDWRITE", secret_access_key: "writesecret" };
const DOSU = "https://api.dosu.test";

let home: string;

/** The bucket and Dosu's sources API behind one global fetch. */
function world(s3: FakeS3) {
  const posts: Record<string, unknown>[] = [];
  const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });
  const fetch = async (url: string, init?: RequestInit) => {
    if (!url.startsWith(DOSU)) return s3.fetch(url, init);
    if (init?.method === "POST") {
      const body = JSON.parse(init.body as string) as Record<string, unknown>;
      posts.push(body);
      return json({
        id: "src-1",
        name: body.name,
        url: `${body.kind}://${body.bucket}/${body.prefix}`,
        owner: body.owner,
      });
    }
    return json({ sources: [] });
  };
  vi.stubGlobal("fetch", fetch);
  return { posts, fetch };
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

function asked(): string[] {
  return [p.text, p.select, p.confirm].flatMap((fn) =>
    vi.mocked(fn).mock.calls.map(([opts]) => (opts as { message: string }).message),
  );
}

function loggedIn(): void {
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
}

beforeEach(() => {
  home = realpathSync(mkdtempSync(join(tmpdir(), "dosu-bucket-wizard-")));
  vi.stubEnv("HOME", home);
  vi.stubEnv("XDG_CONFIG_HOME", join(home, ".config"));
  vi.stubEnv("DOSU_DEV", undefined);
  vi.stubEnv("DOSU_BACKEND_URL_OVERRIDE", DOSU);
  for (const k of ["DOSU_SOURCE", "DOSU_BUCKET", "AWS", "R2"]) {
    vi.stubEnv(`${k}_ACCESS_KEY_ID`, undefined);
    vi.stubEnv(`${k}_SECRET_ACCESS_KEY`, undefined);
  }
  vi.stubEnv("R2_ACCOUNT_ID", undefined);
  vi.stubEnv("AWS_REGION", undefined);
  for (const fn of [p.text, p.select, p.confirm]) vi.mocked(fn).mockReset();
  for (const fn of Object.values(p.log)) vi.mocked(fn).mockReset();
  loggedIn();
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  rmSync(home, { recursive: true, force: true });
});

describe("helpers", () => {
  it("normalizes bucket URLs", () => {
    expect(normalizeBucketUrl(" s3://acme/sessions/ ")).toBe("s3://acme/sessions");
    expect(normalizeBucketUrl("r2://acme")).toBe("r2://acme");
    expect(normalizeBucketUrl("https://acme.s3.amazonaws.com")).toBeUndefined();
    expect(normalizeBucketUrl("s3://")).toBeUndefined();
  });

  it("makes an owner out of the user name", () => {
    expect(defaultOwner()).toMatch(/^[A-Za-z0-9][A-Za-z0-9._-]*$/);
  });
});

describe("runBucketWizard", () => {
  it("with everything given: writes the probe, saves the target as default, connects the bucket with Dosu's own keys", async () => {
    const s3 = fakeS3(ENDPOINT, "acme");
    const w = world(s3);

    const result = await runBucketWizard(
      loadConfig(),
      {
        bucket: "s3://acme/sessions/",
        region: "eu-west-1",
        endpoint: ENDPOINT,
        owner: "james",
        write: WRITE,
        name: "mine",
        read: { access_key_id: "AKIDREAD", secret_access_key: "readsecret" },
        yes: true,
      },
      {},
      w.fetch,
    );

    expect(result?.target).toEqual({
      kind: "bucket",
      name: "mine",
      url: "s3://acme/sessions",
      owner: "james",
      region: "eu-west-1",
      endpoint: ENDPOINT,
      ...WRITE,
      source_id: "src-1",
    });
    expect([...s3.objects.keys()]).toEqual(
      expect.arrayContaining(["sessions/sessionstorage.json", "sessions/owners/james/.probe"]),
    );
    const cfg = loadConfig();
    expect(cfg.default_target).toBe("mine");
    expect(cfg.targets).toEqual([expect.objectContaining({ kind: "bucket", name: "mine" })]);
    // Dosu got the bucket and its read keys; the write key stays on this machine.
    expect(w.posts).toEqual([
      expect.objectContaining({
        kind: "s3",
        bucket: "acme",
        prefix: "sessions",
        owner: "james",
        region: "eu-west-1",
        endpoint: ENDPOINT,
        access_key_id: "AKIDREAD",
        secret_access_key: "readsecret",
      }),
    ]);
    expect(JSON.stringify(w.posts)).not.toContain("writesecret");
    expect(asked()).toEqual([]);
  });

  it("asks an r2:// bucket for its account, and signs for R2's endpoint", async () => {
    const s3 = fakeS3("https://acct.r2.cloudflarestorage.com", "acme");
    const w = world(s3);
    script({
      "Bucket URL": "r2://acme/sessions",
      "Cloudflare account id": "acct",
      "Write keys (this machine): access key id": "AKIDWRITE",
      "Write keys (this machine): secret access key": "writesecret",
      "Your folder in the bucket (owner)": "james",
      "Name for this target": "r2",
      "Let Dosu read the bucket and learn from the sessions in it?": false,
    });

    const result = await runBucketWizard(loadConfig(), {}, {}, w.fetch);

    expect(result?.target).toMatchObject({ url: "r2://acme/sessions", account_id: "acct" });
    expect(s3.requests[0]?.authorization).toContain("/auto/s3/aws4_request");
    expect(asked()).not.toContain("AWS region");
    expect(w.posts).toEqual([]);
  });

  it("takes the write keys from DOSU_BUCKET_*, never the shell's ambient AWS keys", async () => {
    vi.stubEnv("AWS_ACCESS_KEY_ID", "AKIDAMBIENT");
    vi.stubEnv("AWS_SECRET_ACCESS_KEY", "ambient");
    vi.stubEnv("DOSU_BUCKET_ACCESS_KEY_ID", "AKIDWRITE");
    vi.stubEnv("DOSU_BUCKET_SECRET_ACCESS_KEY", "writesecret");
    const s3 = fakeS3(ENDPOINT, "acme");
    const w = world(s3);

    const result = await runBucketWizard(
      loadConfig(),
      { bucket: "s3://acme", endpoint: ENDPOINT, owner: "james", connect: false, yes: true },
      {},
      w.fetch,
    );

    expect(result?.target).toMatchObject({ ...WRITE, region: "us-east-1", name: "bucket" });
    expect(s3.requests.every((r) => r.authorization?.includes("Credential=AKIDWRITE/"))).toBe(true);
  });

  it("under --yes, a bucket that refuses the key is an error and nothing is saved", async () => {
    const s3 = fakeS3(ENDPOINT, "acme");
    s3.deny = true;
    const w = world(s3);

    const err = await runBucketWizard(
      loadConfig(),
      { bucket: "s3://acme", endpoint: ENDPOINT, owner: "james", write: WRITE, yes: true },
      {},
      w.fetch,
    ).catch((e: unknown) => e);

    expect(err).toBeInstanceOf(CliUsageError);
    expect((err as Error).message).toContain("403 AccessDenied");
    expect(loadConfig().targets).toBeUndefined();
  });

  it("interactively, re-asks the write keys after a refusal, and can change the bucket", async () => {
    const s3 = fakeS3(ENDPOINT, "acme");
    s3.deny = true;
    const w = world(s3);
    const keys = ["AKIDWRONG", "AKIDWRITE"];
    script({
      "Bucket URL": ["s3://other", "s3://acme"],
      "AWS region": ["us-east-1", "us-east-1"],
      "S3-compatible endpoint (blank for AWS)": [ENDPOINT, ENDPOINT],
      "Write keys (this machine): access key id": keys,
      "Write keys (this machine): secret access key": ["x", "writesecret"],
      "Your folder in the bucket (owner)": "james",
      "What now?": ["bucket", "keys"],
      "Name for this target": "mine",
      "Let Dosu read the bucket and learn from the sessions in it?": false,
    });
    vi.mocked(p.select).mockImplementation((async (opts: { message: string }) => {
      const next = ["bucket", "keys"][vi.mocked(p.select).mock.calls.length - 1];
      if (next === "keys") s3.deny = false;
      return opts.message === "What now?" ? next : undefined;
    }) as typeof p.select);

    const result = await runBucketWizard(loadConfig(), {}, {}, w.fetch);

    expect(result?.target).toMatchObject({ url: "s3://acme", access_key_id: "AKIDWRITE" });
    expect(asked().filter((m) => m === "Bucket URL")).toHaveLength(2);
  });

  it("returns null when the user cancels after a refusal", async () => {
    const s3 = fakeS3(ENDPOINT, "acme");
    s3.deny = true;
    const w = world(s3);
    script({ "What now?": "cancel" });

    expect(
      await runBucketWizard(
        loadConfig(),
        {
          bucket: "s3://acme",
          region: "us-east-1",
          endpoint: ENDPOINT,
          owner: "james",
          write: WRITE,
        },
        {},
        w.fetch,
      ),
    ).toBeNull();
    expect(loadConfig().targets).toBeUndefined();
  });

  it("keeps the current default unless asked, when another target exists", async () => {
    const cfg = loadConfig();
    cfg.targets = [{ name: "team", url: "https://sessions.example.com", owner: "a", token: "t" }];
    cfg.default_target = "team";
    saveConfig(cfg);
    const s3 = fakeS3(ENDPOINT, "acme");
    const w = world(s3);
    script({ "Name for this target": "bucket", "Ship finished sessions here by default?": false });

    await runBucketWizard(
      loadConfig(),
      {
        bucket: "s3://acme",
        region: "us-east-1",
        endpoint: ENDPOINT,
        owner: "james",
        write: WRITE,
        connect: false,
      },
      {},
      w.fetch,
    );

    expect(loadConfig().default_target).toBe("team");
    expect(loadConfig().targets?.map((t) => t.name)).toEqual(["team", "bucket"]);
  });

  it("without a login, saves the bucket as an archive and does not ask about Dosu", async () => {
    saveConfig(makeTestConfig({ access_token: "", refresh_token: "", expires_at: 0 }));
    const s3 = fakeS3(ENDPOINT, "acme");
    const w = world(s3);

    const result = await runBucketWizard(
      loadConfig(),
      { bucket: "s3://acme", endpoint: ENDPOINT, owner: "james", write: WRITE, yes: true },
      {},
      w.fetch,
    );

    expect(result?.source).toBeUndefined();
    expect(result?.target.source_id).toBeUndefined();
    expect(w.posts).toEqual([]);
  });

  it("validates what is typed: the URL, the owner and the target's name", async () => {
    const s3 = fakeS3(ENDPOINT, "acme");
    const w = world(s3);
    script({
      "Bucket URL": "s3://acme",
      "AWS region": "us-east-1",
      "S3-compatible endpoint (blank for AWS)": ENDPOINT,
      "Write keys (this machine): access key id": "AKIDWRITE",
      "Write keys (this machine): secret access key": "writesecret",
      "Your folder in the bucket (owner)": "james",
      "Name for this target": "mine",
    });

    await runBucketWizard(loadConfig(), { connect: false }, {}, w.fetch);

    const validator = (message: string) =>
      vi
        .mocked(p.text)
        .mock.calls.map(([opts]) => opts)
        .find((opts) => opts.message === message)?.validate as (v: string) => string | undefined;
    expect(validator("Bucket URL")("https://acme")).toMatch(/s3:\/\/bucket/);
    expect(validator("Bucket URL")("r2://acme/x")).toBeUndefined();
    expect(validator("Your folder in the bucket (owner)")("a/b")).toMatch(/one path segment/);
    expect(validator("Your folder in the bucket (owner)")("james")).toBeUndefined();
    expect(validator("Name for this target")("-x")).toMatch(/letters/);
    expect(validator("Name for this target")("mine")).toBeUndefined();
  });

  it("an r2:// bucket with its own endpoint asks for no account id", async () => {
    const s3 = fakeS3(ENDPOINT, "acme");
    const w = world(s3);

    const result = await runBucketWizard(
      loadConfig(),
      {
        bucket: "r2://acme",
        endpoint: ENDPOINT,
        write: WRITE,
        owner: "james",
        connect: false,
        yes: true,
      },
      {},
      w.fetch,
    );

    expect(result?.target).toMatchObject({ url: "r2://acme", endpoint: ENDPOINT });
    expect(result?.target.account_id).toBeUndefined();
    expect(asked()).toEqual([]);
  });

  it("tries the same answers again after a refusal, and keeps a replaced target's source", async () => {
    const s3 = fakeS3(ENDPOINT, "acme");
    s3.deny = true;
    const w = world(s3);
    saveConfig({
      ...loadConfig(),
      targets: [
        {
          kind: "bucket",
          name: "mine",
          url: "s3://old",
          owner: "james",
          access_key_id: "old",
          secret_access_key: "old",
          source_id: "src-old",
        },
      ],
    });
    script({
      "S3-compatible endpoint (blank for AWS)": ENDPOINT,
      "What now?": "retry",
      "Name for this target": "mine",
    });
    vi.mocked(p.select).mockImplementation((async () => {
      s3.deny = false;
      return "retry";
    }) as typeof p.select);

    const result = await runBucketWizard(
      loadConfig(),
      { bucket: "s3://acme", region: "us-east-1", write: WRITE, owner: "james", connect: false },
      {},
      w.fetch,
    );

    expect(result?.target).toMatchObject({ url: "s3://acme", source_id: "src-old" });
    expect(asked().filter((m) => m === "S3-compatible endpoint (blank for AWS)")).toHaveLength(1);
  });

  it("refuses an owner that is not one path segment", async () => {
    const s3 = fakeS3(ENDPOINT, "acme");
    const w = world(s3);
    await expect(
      runBucketWizard(
        loadConfig(),
        { bucket: "s3://acme", endpoint: ENDPOINT, owner: "a/b", write: WRITE, yes: true },
        {},
        w.fetch,
      ),
    ).rejects.toThrow(/not an owner name/);
  });

  it("refuses a URL that is not a bucket", async () => {
    await expect(
      runBucketWizard(loadConfig(), { bucket: "https://acme", yes: true }),
    ).rejects.toThrow(/not a bucket URL/);
  });
});
