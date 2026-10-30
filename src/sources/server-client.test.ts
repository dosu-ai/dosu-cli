import { ServerError, StoreError } from "@dosu-ai/sessiondb";
import { describe, expect, it, vi } from "vitest";
import { describeServerError, isUnauthorized, isUnreachable, serverClient } from "./server-client";

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
