/** A bucket target: the SDK redacts and normalizes the session on this machine and writes the
 * bucket itself, signed with the target's key; nothing goes to a server. */

import { gunzipSync } from "node:zlib";
import { describe, expect, it, vi } from "vitest";
import type { BucketTarget } from "../config/schema";
import { fakeS3 } from "./fake-s3.test-utils";
import { bucketClientOf, shipTargetOf } from "./select";
import { createBucketTarget } from "./target";

vi.mock("../debug/logger", () => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

const ENDPOINT = "http://s3.test:9000";
const SECRET = "ghp_abcdefghijklmnopqrstuvwxyz0123456789";

function line(record: Record<string, unknown>): string {
  return `${JSON.stringify({ sessionId: "sess1", timestamp: "2026-09-01T00:00:00.000Z", ...record })}\n`;
}

/** A Claude Code log long enough to be worth a trace, with a token in it. */
const TRANSCRIPT =
  line({
    type: "user",
    uuid: "u1",
    cwd: "/repo/app",
    gitBranch: "main",
    message: {
      role: "user",
      content: `How does the change feed work? My token is ${SECRET}. ${"Explain the layout. ".repeat(80)}`,
    },
  }) +
  line({
    type: "assistant",
    uuid: "a1",
    message: {
      role: "assistant",
      model: "claude-x",
      content: [
        { type: "text", text: "It is an append-only list of keys under changes/. ".repeat(20) },
      ],
    },
  });

function target(s3: ReturnType<typeof fakeS3>, url = "s3://acme/sessions") {
  return createBucketTarget({
    name: "mine",
    url,
    owner: "james",
    region: "us-east-1",
    endpoint: ENDPOINT,
    credentials: { accessKeyId: "AKIDWRITE", secretAccessKey: "writesecret" },
    fetchImpl: s3.fetch,
  });
}

const UPLOAD = {
  agent: "claude-code",
  session_id: "sess1",
  transcript: TRANSCRIPT,
  format: "jsonl" as const,
  project: "github.com/acme/app",
};

describe("createBucketTarget", () => {
  it("writes a redacted trace under owners/<owner>/ with signed requests", async () => {
    const s3 = fakeS3(ENDPOINT, "acme");

    const result = await target(s3).send(UPLOAD);

    expect(result).toMatchObject({ status: "shipped", taskId: expect.stringMatching(/^stored:/) });
    const keys = [...s3.objects.keys()];
    expect(keys).toContain("sessions/sessionstorage.json");
    expect(keys.some((k) => k.startsWith("sessions/owners/james/changes/"))).toBe(true);
    expect(
      keys.some((k) => /^sessions\/owners\/james\/sessions\/.+\/trace\..+\.json\.gz$/.test(k)),
    ).toBe(true);
    expect(keys.some((k) => /\/raw\.0\.jsonl\.gz$/.test(k))).toBe(true);
    // Redacted here, before any byte reached the bucket: raw part and trace alike.
    for (const [key, bytes] of s3.objects) {
      const text = new TextDecoder().decode(key.endsWith(".gz") ? gunzipSync(bytes) : bytes);
      expect(text).not.toContain(SECRET);
    }
    const raw = [...s3.objects].find(([k]) => k.endsWith("raw.0.jsonl.gz"))?.[1] as Uint8Array;
    expect(new TextDecoder().decode(gunzipSync(raw))).toContain("Explain the layout.");
    expect(s3.requests.every((r) => r.authorization?.includes("Credential=AKIDWRITE/"))).toBe(true);
    expect(s3.requests.every((r) => r.url.startsWith(`${ENDPOINT}/acme/`))).toBe(true);
  });

  it("answers a resend of the same session as shipped (a duplicate), and a greeting as trivial", async () => {
    const s3 = fakeS3(ENDPOINT, "acme");
    const t = target(s3);
    const first = await t.send(UPLOAD);
    expect(await t.send(UPLOAD)).toMatchObject({
      status: "shipped",
      taskId: expect.stringMatching(/^duplicate:/),
      shipped: first.status === "shipped" ? first.shipped : undefined,
    });
    const hello = line({ type: "user", uuid: "u9", message: { role: "user", content: "hi" } });
    expect(await t.send({ ...UPLOAD, session_id: "sess2", transcript: hello })).toMatchObject({
      status: "trivial",
    });
  });

  it("fails, to be retried, when the bucket refuses the key, naming the bucket", async () => {
    const s3 = fakeS3(ENDPOINT, "acme");
    s3.deny = true;
    const result = await target(s3).send(UPLOAD);
    expect(result.status).toBe("failed");
    expect(result.status === "failed" && result.message).toMatch(/^bucket s3:\/\/acme\/sessions: /);
  });

  it("rejects an agent the SDK has no adapter for, without touching the bucket", async () => {
    const s3 = fakeS3(ENDPOINT, "acme");
    expect(await target(s3).send({ ...UPLOAD, agent: "nope" })).toEqual({
      status: "rejected",
      message: "unsupported_source: nope",
    });
    expect(s3.requests).toEqual([]);
  });
});

describe("configured bucket targets", () => {
  const configured: BucketTarget = {
    kind: "bucket",
    name: "mine",
    url: "r2://acme/sessions",
    owner: "james",
    account_id: "acct",
    access_key_id: "AKIDWRITE",
    secret_access_key: "writesecret",
    session_token: "tok",
  };

  it("ship to the bucket they name", () => {
    expect(shipTargetOf(configured)).toMatchObject({ name: "mine", url: "r2://acme/sessions" });
  });

  it("give redact a client over the same bucket and owner", async () => {
    expect(await bucketClientOf(configured).me()).toMatchObject({
      owner: "james",
      storage: { url: "r2://acme/sessions", account_id: "acct" },
    });
  });
});
