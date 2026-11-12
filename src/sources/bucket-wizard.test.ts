/** A member's folder of the org's bucket store, written from this machine: the write key is
 * checked by writing the bucket, and the target is saved with it. Nothing here connects a bucket
 * to Dosu. */

import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir, userInfo } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CliUsageError } from "../cli/errors";
import { loadConfig, saveConfig } from "../config/config";
import { makeTestConfig } from "../config/config.test-utils";
import { fakeS3 } from "../shipper/fake-s3.test-utils";
import * as p from "../tui/prompts";
import {
  askBucketUrl,
  bucketUrlOf,
  defaultOwner,
  normalizeBucketUrl,
  runBucketWizard,
} from "./bucket-wizard";
import type { Asker } from "./prompts";

vi.mock("node:os", async (importOriginal) => {
  const os = await importOriginal<typeof import("node:os")>();
  return { ...os, userInfo: vi.fn(os.userInfo) };
});

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

let home: string;

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

beforeEach(() => {
  home = realpathSync(mkdtempSync(join(tmpdir(), "dosu-bucket-wizard-")));
  vi.stubEnv("HOME", home);
  vi.stubEnv("XDG_CONFIG_HOME", join(home, ".config"));
  vi.stubEnv("DOSU_DEV", undefined);
  for (const k of ["DOSU_SOURCE", "DOSU_BUCKET", "AWS", "R2"]) {
    vi.stubEnv(`${k}_ACCESS_KEY_ID`, undefined);
    vi.stubEnv(`${k}_SECRET_ACCESS_KEY`, undefined);
  }
  for (const fn of [p.text, p.select, p.confirm]) vi.mocked(fn).mockReset();
  for (const fn of Object.values(p.log)) vi.mocked(fn).mockReset();
  saveConfig(makeTestConfig({ access_token: "t", refresh_token: "r", expires_at: 0 }));
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

  it("makes a picked service's URL out of a bucket name, dropping that service's own scheme", () => {
    expect(bucketUrlOf("r2", " acme/sessions/ ")).toBe("r2://acme/sessions");
    expect(bucketUrlOf("s3", "s3://acme")).toBe("s3://acme");
    expect(bucketUrlOf("s3", "r2://acme")).toBeUndefined();
    expect(bucketUrlOf("s3", "")).toBeUndefined();
  });

  it("refuses a bucket name the prompt's validation did not check", async () => {
    // A given answer skips the prompt, and with it the validation.
    const ask = {
      select: async () => "s3",
      text: async () => "not a bucket",
      confirm: async () => true,
    } as unknown as Asker;
    await expect(askBucketUrl(ask, undefined)).rejects.toThrow(
      new CliUsageError("not a bucket name: not a bucket"),
    );
  });

  it("falls back to 'me' for a user name with nothing usable, or none at all", () => {
    vi.mocked(userInfo).mockReturnValueOnce({ username: "@@@" } as ReturnType<typeof userInfo>);
    expect(defaultOwner()).toBe("me");
    vi.mocked(userInfo).mockImplementationOnce(() => {
      throw new Error("no passwd entry");
    });
    expect(defaultOwner()).toBe("me");
  });

  it("makes an owner out of the user name", () => {
    expect(defaultOwner()).toMatch(/^[A-Za-z0-9][A-Za-z0-9._-]*$/);
  });
});

/** The org's bucket store, as joining it hands it over: the folder is claimed already. */
const ORG = { bucket: "s3://acme", region: "us-east-1", endpoint: ENDPOINT, owner: "james" };

describe("runBucketWizard: the member's write key", () => {
  it("writes the layout marker and the folder's probe, and saves the target as the default", async () => {
    const s3 = fakeS3(ENDPOINT, "acme");

    const result = await runBucketWizard(
      loadConfig(),
      { ...ORG, write: WRITE, name: "org", yes: true },
      {},
      s3.fetch,
    );

    expect(result?.target).toEqual({
      kind: "bucket",
      name: "org",
      url: "s3://acme",
      owner: "james",
      region: "us-east-1",
      endpoint: ENDPOINT,
      ...WRITE,
    });
    expect([...s3.objects.keys()]).toContain("owners/james/.probe");
    expect(loadConfig().default_target).toBe("org");
    const told = vi
      .mocked(p.log.message)
      .mock.calls.map(([line]) => String(line))
      .join(" ")
      .replace(/\s+/g, " ");
    expect(told).toContain("the org's own read-only key");
    expect(told).toContain("can add to it");
  });

  it("takes the write keys from DOSU_BUCKET_*, never the shell's ambient AWS keys", async () => {
    vi.stubEnv("AWS_ACCESS_KEY_ID", "AKIDAMBIENT");
    vi.stubEnv("AWS_SECRET_ACCESS_KEY", "ambient");
    vi.stubEnv("DOSU_BUCKET_ACCESS_KEY_ID", "AKIDWRITE");
    vi.stubEnv("DOSU_BUCKET_SECRET_ACCESS_KEY", "writesecret");
    const s3 = fakeS3(ENDPOINT, "acme");

    const result = await runBucketWizard(loadConfig(), { ...ORG, yes: true }, {}, s3.fetch);

    expect(result?.target).toMatchObject({ ...WRITE, name: "org" });
    expect(s3.requests.every((r) => r.authorization?.includes("Credential=AKIDWRITE/"))).toBe(true);
  });

  it("under --yes, a bucket that refuses the key is an error and nothing is saved", async () => {
    const s3 = fakeS3(ENDPOINT, "acme");
    s3.deny = true;

    const err = await runBucketWizard(
      loadConfig(),
      { ...ORG, write: WRITE, yes: true },
      {},
      s3.fetch,
    ).catch((e: unknown) => e);

    expect(err).toBeInstanceOf(CliUsageError);
    expect((err as Error).message).toContain("403 AccessDenied");
    expect(loadConfig().targets).toBeUndefined();
  });

  it("interactively, re-asks the write key after a refusal, or tries the same one again", async () => {
    const s3 = fakeS3(ENDPOINT, "acme");
    s3.deny = true;
    script({
      "Write key (this machine): access key id": ["AKIDWRONG", "AKIDWRITE"],
      "Write key (this machine): secret access key": ["x", "writesecret"],
      "Name for this target": "org",
    });
    vi.mocked(p.select).mockImplementation((async () => {
      s3.deny = false;
      return "keys";
    }) as typeof p.select);

    const result = await runBucketWizard(loadConfig(), ORG, {}, s3.fetch);

    expect(result?.target).toMatchObject({ url: "s3://acme", access_key_id: "AKIDWRITE" });
    expect(asked().filter((m) => m === "What now?")).toHaveLength(1);

    s3.deny = true;
    vi.mocked(p.select).mockImplementation((async () => {
      s3.deny = false;
      return "retry";
    }) as typeof p.select);
    vi.mocked(p.text).mockClear();
    const again = await runBucketWizard(
      loadConfig(),
      { ...ORG, write: WRITE, name: "org" },
      {},
      s3.fetch,
    );
    expect(again?.target.access_key_id).toBe("AKIDWRITE");
    expect(vi.mocked(p.text)).not.toHaveBeenCalled();
  });

  it("returns null when the user cancels after a refusal", async () => {
    const s3 = fakeS3(ENDPOINT, "acme");
    s3.deny = true;
    script({ "What now?": "cancel" });

    expect(await runBucketWizard(loadConfig(), { ...ORG, write: WRITE }, {}, s3.fetch)).toBeNull();
    expect(loadConfig().targets).toBeUndefined();
  });

  it("keeps the current default unless asked, and a replaced target's source", async () => {
    const cfg = loadConfig();
    cfg.targets = [
      { name: "team", url: "https://sessions.example.com", owner: "a", token: "t" },
      {
        kind: "bucket",
        name: "org",
        url: "s3://old",
        owner: "james",
        access_key_id: "old",
        secret_access_key: "old",
        source_id: "src-old",
      },
    ];
    cfg.default_target = "team";
    saveConfig(cfg);
    const s3 = fakeS3(ENDPOINT, "acme");
    script({ "Ship finished sessions here by default?": false });

    const result = await runBucketWizard(
      loadConfig(),
      { ...ORG, write: WRITE, name: "org" },
      {},
      s3.fetch,
    );

    expect(result?.target.source_id).toBe("src-old");
    expect(loadConfig().default_target).toBe("team");
    expect(loadConfig().targets?.map((t) => t.name)).toEqual(["team", "org"]);
  });

  it("validates the target's name, and an r2:// store with its own endpoint", async () => {
    const s3 = fakeS3(ENDPOINT, "acme");
    script({ "Name for this target": "mine" });

    const result = await runBucketWizard(
      loadConfig(),
      { bucket: "r2://acme", endpoint: ENDPOINT, owner: "james", write: WRITE },
      {},
      s3.fetch,
    );

    expect(result?.target).toMatchObject({ url: "r2://acme", endpoint: ENDPOINT, name: "mine" });
    expect(result?.target.account_id).toBeUndefined();
    const validate = vi.mocked(p.text).mock.calls[0]?.[0].validate as (
      v: string,
    ) => string | undefined;
    expect(validate("-x")).toMatch(/letters/);
    expect(validate("mine")).toBeUndefined();
  });

  it("refuses a URL that is not a bucket", async () => {
    await expect(
      runBucketWizard(loadConfig(), { bucket: "https://acme", owner: "james", yes: true }),
    ).rejects.toThrow(/not a bucket URL/);
  });
});
