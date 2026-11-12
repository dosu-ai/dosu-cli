import { ServerError, StoreError } from "@dosu/sessiondb";
import { describe, expect, it, vi } from "vitest";
import { bucketOfStorage } from "./bucket";
import {
  bucketOfTarget,
  describeServerError,
  isUnauthorized,
  isUnreachable,
  normalizeServerUrl,
  serverClient,
} from "./server-client";

describe("serverClient", () => {
  it("is the SDK's HTTP client with the CLI's User-Agent", async () => {
    const fetchImpl = vi.fn(async () =>
      Response.json({ owner: "acme", storage: { url: "r2://acme/sessions" } }),
    );
    const me = await serverClient({ url: "https://s.test/", token: "sdb_t" }, fetchImpl).me();
    expect(me.owner).toBe("acme");
    const [url, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("https://s.test/v1/me");
    expect(new Headers(init.headers).get("user-agent")).toMatch(/^dosu-cli\//);
    expect(new Headers(init.headers).get("authorization")).toBe("Bearer sdb_t");
  });
});

describe("describeServerError", () => {
  it("reads the server's envelope, else the status, else whatever was thrown", () => {
    expect(describeServerError(new ServerError(409, "no_storage", "link a bucket"))).toBe(
      "no_storage: link a bucket",
    );
    expect(describeServerError(new ServerError(502, "unknown", "HTTP 502"))).toBe("HTTP 502");
    expect(describeServerError(new StoreError("cannot reach https://s.test: ECONNREFUSED"))).toBe(
      "cannot reach https://s.test: ECONNREFUSED",
    );
    expect(describeServerError(new Error("boom"))).toBe("boom");
    expect(describeServerError("on fire")).toBe("on fire");
  });
});

describe("isUnreachable and isUnauthorized", () => {
  it("tell a server that never answered from one that refused", () => {
    expect(isUnreachable(new StoreError("cannot reach", new Error("ECONNREFUSED")))).toBe(true);
    expect(isUnreachable(new StoreError("bucket unavailable"))).toBe(false);
    expect(isUnreachable(new ServerError(401, "unauthorized", "nope"))).toBe(false);
    expect(isUnauthorized(new ServerError(401, "unauthorized", "nope"))).toBe(true);
    expect(isUnauthorized(new ServerError(403, "forbidden", "nope"))).toBe(false);
    expect(isUnauthorized(new Error("nope"))).toBe(false);
  });
});

describe("normalizeServerUrl and bucketOfStorage", () => {
  it("normalizes server URLs", () => {
    expect(normalizeServerUrl(" https://s.example.com/ ")).toBe("https://s.example.com");
    expect(normalizeServerUrl("http://localhost:7200")).toBe("http://localhost:7200");
    expect(normalizeServerUrl("http://127.0.0.1:7200/")).toBe("http://127.0.0.1:7200");
    expect(normalizeServerUrl("http://sessions.example.com")).toBeUndefined();
    expect(normalizeServerUrl("s3://bucket")).toBeUndefined();
    expect(normalizeServerUrl("example.com")).toBeUndefined();
    expect(normalizeServerUrl("https://example.com:99999")).toBeUndefined();
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

describe("bucketOfTarget", () => {
  const SERVER = "https://sessions.example.com";
  const fetchImpl = async (url: string, init?: RequestInit) => {
    const ok = new Headers(init?.headers).get("authorization") === "Bearer sdb_t";
    if (!ok) {
      return Response.json({ error: { code: "unauthorized", message: "nope" } }, { status: 401 });
    }
    return url.endsWith("/v1/me")
      ? Response.json({
          owner: "acme",
          storage: { url: "r2://acme-sessions/dosu", account_id: "acct" },
        })
      : Response.json({ error: { code: "not_found" } }, { status: 404 });
  };

  it("asks a server target for the bucket it writes", async () => {
    expect(
      await bucketOfTarget({ name: "team", url: SERVER, owner: "acme", token: "sdb_t" }, fetchImpl),
    ).toEqual({
      url: "r2://acme-sessions/dosu",
      scheme: "r2",
      bucket: "acme-sessions",
      prefix: "dosu",
      account_id: "acct",
    });
    await expect(
      bucketOfTarget({ name: "team", url: SERVER, owner: "acme", token: "sdb_x" }, fetchImpl),
    ).rejects.toThrow(/answered/);
  });

  it("keeps an S3-compatible endpoint, and says when the server never answered", async () => {
    const minio = async () =>
      Response.json({
        owner: "acme",
        storage: { url: "s3://acme/dosu", region: "us-east-1", endpoint: "https://minio.test" },
      });
    expect(
      await bucketOfTarget({ name: "team", url: SERVER, owner: "acme", token: "sdb_t" }, minio),
    ).toMatchObject({ scheme: "s3", region: "us-east-1", endpoint: "https://minio.test" });

    const down = async (): Promise<Response> => {
      throw new TypeError("fetch failed");
    };
    const err = await bucketOfTarget(
      { name: "team", url: SERVER, owner: "acme", token: "sdb_t" },
      down,
    ).catch((e: Error) => e);
    expect(err).toBeInstanceOf(Error);
    expect((err as Error).message).not.toMatch(/answered/);
  });

  it("refuses a server that writes a folder on its own disk", async () => {
    const folder = async () =>
      Response.json({ owner: "acme", storage: { url: "file:///srv/sessions" } });
    await expect(
      bucketOfTarget({ name: "team", url: SERVER, owner: "acme", token: "sdb_t" }, folder),
    ).rejects.toThrow(/not a bucket Dosu can read/);
  });
});
