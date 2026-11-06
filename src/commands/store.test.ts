/** `dosu redact` on a bucket target: the session is tombstoned in the bucket from here, with
 * the target's own key, as the server would do it for a server target. */

import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { saveConfig } from "../config/config";
import { makeTestConfig } from "../config/config.test-utils";
import type { BucketTarget } from "../config/schema";
import { fakeS3 } from "../shipper/fake-s3.test-utils";
import { bucketClientOf } from "../shipper/select";
import { storeCommands } from "./store";

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

let home: string;
let out: string[];

beforeEach(() => {
  home = realpathSync(mkdtempSync(join(tmpdir(), "dosu-store-")));
  vi.stubEnv("HOME", home);
  vi.stubEnv("XDG_CONFIG_HOME", join(home, ".config"));
  saveConfig({
    ...makeTestConfig({ access_token: "", refresh_token: "", expires_at: 0 }),
    targets: [BUCKET],
    default_target: "mine",
  });
  out = [];
  vi.spyOn(console, "log").mockImplementation((...args: unknown[]) => {
    out.push(args.join(" "));
  });
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  rmSync(home, { recursive: true, force: true });
});

async function dosu(...args: string[]): Promise<void> {
  const [cmd] = storeCommands();
  cmd?.exitOverride();
  await cmd?.parseAsync(["node", "redact", ...args]);
}

describe("redact on a bucket target", () => {
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

    await dosu("claude:sess1", "--yes");

    expect(out.join("\n")).toMatch(/Redacted claude:sess1 from mine: \d+ objects? removed/);
    expect(raw()).toEqual([]);
    expect([...s3.objects.keys()].some((k) => k.endsWith("-tombstone.json"))).toBe(true);
    expect((await bucketClientOf(BUCKET).getSession("claude-code", "sess1"))?.status).toBe(
      "redacted",
    );
    await expect(dosu("claude:other", "--yes")).rejects.toThrow(/is not on mine/);
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
    const fetch = vi.fn(async (_url: string) => new Response(JSON.stringify({ removed: 3 })));
    vi.stubGlobal("fetch", fetch);

    await dosu("claude:sess1", "--yes", "--target", "team");

    expect(String(fetch.mock.calls[0]?.[0])).toBe(
      "https://sessions.example.com/v1/sessions/claude-code/sess1",
    );
    expect(out.join("\n")).toContain("Redacted claude:sess1 from team: 3 objects removed");
  });
});
