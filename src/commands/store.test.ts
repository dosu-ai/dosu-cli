import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CliUsageError } from "../cli/errors";
import { saveConfig } from "../config/config";
import { makeTestConfig } from "../config/config.test-utils";
import type { BucketTarget } from "../config/schema";
import { fakeS3 } from "../shipper/fake-s3.test-utils";
import { bucketClientOf } from "../shipper/select";
import { storeCommands } from "./store";

const TOKEN = "sdb_0123456789abcdef";

let dir: string;
let fetchImpl: ReturnType<typeof vi.fn>;
let logSpy: ReturnType<typeof vi.spyOn>;

async function run(...args: string[]): Promise<void> {
  const [redact] = storeCommands();
  redact?.exitOverride();
  await redact?.parseAsync(["node", "redact", ...args]);
}

/** The URL and bearer token of the one request the command sent. */
function sent(): { url: string; method?: string; authorization?: string } {
  const [url, init] = fetchImpl.mock.calls[0] as [string, RequestInit];
  const headers = init.headers as Record<string, string>;
  return { url: String(url), method: init.method, authorization: headers.authorization };
}

/** Everything the command printed. */
function printed(): string {
  return logSpy.mock.calls.map((args: unknown[]) => args.join(" ")).join("\n");
}

beforeEach(() => {
  dir = realpathSync(mkdtempSync(join(tmpdir(), "dosu-redact-")));
  vi.stubEnv("HOME", dir);
  vi.stubEnv("XDG_CONFIG_HOME", join(dir, ".config"));
  vi.stubEnv("DOSU_SESSIONDB_URL", undefined);
  vi.stubEnv("DOSU_SESSIONDB_TOKEN", undefined);
  fetchImpl = vi.fn(async () => new Response(JSON.stringify({ removed: 3 }), { status: 200 }));
  vi.stubGlobal("fetch", fetchImpl);
  logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
});

afterEach(() => {
  logSpy.mockRestore();
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  rmSync(dir, { recursive: true, force: true });
});

describe("dosu redact", () => {
  it("redacts on DOSU_SESSIONDB_URL with its token when nothing is configured", async () => {
    vi.stubEnv("DOSU_SESSIONDB_URL", "https://sessions.test/");
    vi.stubEnv("DOSU_SESSIONDB_TOKEN", TOKEN);

    await run("claude:sess1", "--yes");

    expect(sent()).toEqual({
      url: "https://sessions.test/v1/sessions/claude-code/sess1",
      method: "DELETE",
      authorization: `Bearer ${TOKEN}`,
    });
    expect(String(logSpy.mock.calls[0]?.[0])).toBe(
      "Redacted claude:sess1 from env: 3 objects removed",
    );
  });

  it("prefers the environment's server to the configured default, as sessions push does", async () => {
    vi.stubEnv("DOSU_SESSIONDB_URL", "https://sessions.test");
    vi.stubEnv("DOSU_SESSIONDB_TOKEN", TOKEN);
    saveConfig({
      ...makeTestConfig({ access_token: "t", refresh_token: "r", expires_at: 0 }),
      targets: [{ name: "team", url: "https://team.test", owner: "ci", token: "sdb_team" }],
    });

    await run("claude:sess1", "--yes");

    expect(sent().url).toBe("https://sessions.test/v1/sessions/claude-code/sess1");
  });

  it("uses the configured target --target names, whatever the environment says", async () => {
    vi.stubEnv("DOSU_SESSIONDB_URL", "https://sessions.test");
    vi.stubEnv("DOSU_SESSIONDB_TOKEN", TOKEN);
    saveConfig({
      ...makeTestConfig({ access_token: "t", refresh_token: "r", expires_at: 0 }),
      targets: [{ name: "team", url: "https://team.test", owner: "ci", token: "sdb_team" }],
    });

    await run("claude:sess1", "--yes", "--target", "team");

    expect(sent()).toMatchObject({
      url: "https://team.test/v1/sessions/claude-code/sess1",
      authorization: "Bearer sdb_team",
    });
  });

  it("redacts from Dosu when neither the config nor the environment names a server", async () => {
    const error = await run("claude:sess1", "--yes").catch((err: unknown) => err);

    expect(error).toBeInstanceOf(CliUsageError);
    expect((error as Error).message).toBe("not logged in to Dosu: run 'dosu setup'");
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("redacts from Dosu on --target with nothing configured, whatever the environment says", async () => {
    vi.stubEnv("DOSU_SESSIONDB_URL", "https://sessions.test");
    vi.stubEnv("DOSU_SESSIONDB_TOKEN", TOKEN);

    const error = await run("claude:sess1", "--yes", "--target", "team").catch(
      (err: unknown) => err,
    );

    expect((error as Error).message).toBe("not logged in to Dosu: run 'dosu setup'");
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("refuses a --target that is not configured", async () => {
    saveConfig({
      ...makeTestConfig({ access_token: "t", refresh_token: "r", expires_at: 0 }),
      targets: [{ name: "team", url: "https://team.test", owner: "ci", token: "sdb_team" }],
    });

    const error = await run("claude:sess1", "--yes", "--target", "other").catch(
      (err: unknown) => err,
    );

    expect(error).toBeInstanceOf(CliUsageError);
    expect((error as Error).message).toContain("unknown target 'other' (configured: team)");
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("refuses a plain http:// server that is not this machine", async () => {
    vi.stubEnv("DOSU_SESSIONDB_URL", "http://sessions.example.com");
    vi.stubEnv("DOSU_SESSIONDB_TOKEN", TOKEN);

    const error = await run("claude:sess1", "--yes").catch((err: unknown) => err);

    expect(error).toBeInstanceOf(CliUsageError);
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});

/** `dosu redact` on a bucket target: the session is tombstoned in the bucket from here, with
 * the target's own key, as the server would do it for a server target. */
describe("redact on a bucket target", () => {
  const ENDPOINT = "http://s3.test:9000";
  const BUCKET: BucketTarget = {
    kind: "bucket",
    name: "mine",
    url: "s3://acme/sessions",
    owner: "james",
    region: "us-east-1",
    endpoint: ENDPOINT,
    access_key_id: "AKIDWRITE",
    secret_access_key: "writesecret",
  };

  beforeEach(() => {
    saveConfig({
      ...makeTestConfig({ access_token: "", refresh_token: "", expires_at: 0 }),
      targets: [BUCKET],
      default_target: "mine",
    });
  });

  it("tombstones the session in the bucket, and says when it is not there", async () => {
    const s3 = fakeS3(ENDPOINT, "acme");
    vi.stubGlobal("fetch", s3.fetch);
    const transcript = `${JSON.stringify({
      type: "user",
      uuid: "u1",
      sessionId: "sess1",
      timestamp: "2026-09-01T00:00:00.000Z",
      message: { role: "user", content: "hello" },
    })}\n`;
    await bucketClientOf(BUCKET).ingest({ agent: "claude-code", session_id: "sess1", transcript });
    const raw = () => [...s3.objects.keys()].filter((k) => /\/raw\.\d+\.jsonl\.gz$/.test(k));
    expect(raw()).toHaveLength(1);

    await run("claude:sess1", "--yes");

    expect(printed()).toMatch(/Redacted claude:sess1 from mine: \d+ objects? removed/);
    expect(raw()).toEqual([]);
    expect([...s3.objects.keys()].some((k) => k.endsWith("-tombstone.json"))).toBe(true);
    expect((await bucketClientOf(BUCKET).getSession("claude-code", "sess1"))?.status).toBe(
      "redacted",
    );
    await expect(run("claude:other", "--yes")).rejects.toThrow(/is not on mine/);
  });

  it("a server target still redacts through the server's API", async () => {
    const team = {
      name: "team",
      url: "https://sessions.example.com",
      owner: "james",
      token: "sdb",
    };
    saveConfig({
      ...makeTestConfig({ access_token: "", refresh_token: "", expires_at: 0 }),
      targets: [BUCKET, team],
      default_target: "mine",
    });

    await run("claude:sess1", "--yes", "--target", "team");

    expect(String(fetchImpl.mock.calls[0]?.[0])).toBe(
      "https://sessions.example.com/v1/sessions/claude-code/sess1",
    );
    expect(printed()).toContain("Redacted claude:sess1 from team: 3 objects removed");
  });

  it("prefers DOSU_SESSIONDB_URL to a default bucket target, as sessions push does", async () => {
    vi.stubEnv("DOSU_SESSIONDB_URL", "https://sessions.test");
    vi.stubEnv("DOSU_SESSIONDB_TOKEN", TOKEN);

    await run("claude:sess1", "--yes");

    expect(sent().url).toBe("https://sessions.test/v1/sessions/claude-code/sess1");
  });
});
