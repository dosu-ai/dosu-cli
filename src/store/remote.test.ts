import { StoreError } from "@dosu/sessionstorage";
import { describe, expect, it, vi } from "vitest";
import { RemoteStore, serverError } from "./remote";

function store(fetchImpl: ReturnType<typeof vi.fn>): RemoteStore {
  return new RemoteStore({
    url: "https://sessions.example.com/",
    token: "sdb_test",
    fetchImpl: fetchImpl as unknown as (input: string, init?: RequestInit) => Promise<Response>,
  });
}

describe("RemoteStore", () => {
  it("gets an object under the owner's prefix with the bearer token", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(new Response(new Uint8Array([1, 2, 3])));
    const bytes = await store(fetchImpl).get("owners/acme/sessions/ab/metadata.json");
    expect(Array.from(bytes as Uint8Array)).toEqual([1, 2, 3]);
    const [url, init] = fetchImpl.mock.calls[0] as [string, RequestInit];
    expect(url).toBe(
      "https://sessions.example.com/v1/objects/owners/acme/sessions/ab/metadata.json",
    );
    expect(init.method).toBe("GET");
    expect((init.headers as Record<string, string>).authorization).toBe("Bearer sdb_test");
  });

  it("encodes key segments and treats 404 as null", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(new Response(null, { status: 404 }));
    const s = store(fetchImpl);
    expect(await s.get("owners/acme/a b")).toBeNull();
    expect((fetchImpl.mock.calls[0] as [string])[0]).toContain("/v1/objects/owners/acme/a%20b");
    expect(await s.stat("owners/acme/x")).toBeNull();
  });

  it("stats from headers and lists through the objects query", async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(
        new Response(null, { headers: { "content-length": "42", etag: '"abc"' } }),
      )
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ keys: ["owners/acme/sessions/x"], truncated: false })),
      );
    const s = store(fetchImpl);
    expect(await s.stat("owners/acme/x")).toEqual({ size: 42, etag: '"abc"' });
    const page = await s.list("owners/acme/sessions/", {
      startAfter: "owners/acme/sessions/a",
      limit: 5,
    });
    expect(page).toEqual({ keys: ["owners/acme/sessions/x"], truncated: false });
    const url = new URL((fetchImpl.mock.calls[1] as [string])[0]);
    expect(url.pathname).toBe("/v1/objects");
    expect(url.searchParams.get("prefix")).toBe("owners/acme/sessions/");
    expect(url.searchParams.get("after")).toBe("owners/acme/sessions/a");
    expect(url.searchParams.get("limit")).toBe("5");
  });

  it("turns server errors and network failures into StoreError", async () => {
    const denied = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ error: { code: "forbidden", message: "not yours" } }), {
        status: 403,
      }),
    );
    await expect(store(denied).get("owners/globex/x")).rejects.toThrow(/forbidden: not yours/);
    const down = vi.fn().mockRejectedValue(new Error("ECONNREFUSED"));
    await expect(store(down).list("owners/acme/")).rejects.toBeInstanceOf(StoreError);
  });

  it("reports non-404 failures of stat and list", async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(new Response(null, { status: 500 }))
      .mockResolvedValueOnce(new Response("nope", { status: 503 }))
      .mockResolvedValueOnce(new Response(new Uint8Array([1]), { status: 200 }));
    const s = store(fetchImpl);
    await expect(s.stat("owners/acme/x")).rejects.toThrow(/stat owners\/acme\/x: HTTP 500/);
    await expect(s.list("owners/acme/")).rejects.toThrow(/HTTP 503/);
    // No content-length header: size 0, no etag.
    const fetch2 = vi.fn().mockResolvedValue(new Response(null, { status: 200 }));
    expect(await store(fetch2).stat("owners/acme/y")).toEqual({ size: 0 });
    // The default fetch and timeout are used when none is given.
    expect(new RemoteStore({ url: "https://x", token: "t" }).url).toBe("https://x");
  });

  it("refuses writes: a server target is written through its API", async () => {
    const s = store(vi.fn());
    await expect(s.put("owners/acme/x", new Uint8Array())).rejects.toThrow(/through its API/);
    await expect(s.delete("owners/acme/x")).rejects.toThrow(/through its API/);
  });
});

describe("serverError", () => {
  it("prefers the server's code and message, else the status", async () => {
    expect(
      await serverError(
        new Response(JSON.stringify({ error: { code: "empty", message: "nothing" } }), {
          status: 422,
        }),
      ),
    ).toBe("empty: nothing");
    expect(await serverError(new Response("<html>", { status: 502 }))).toBe("HTTP 502");
    expect(
      await serverError(new Response(JSON.stringify({ error: { message: "m" } }), { status: 400 })),
    ).toBe("m");
    expect(await serverError(new Response(JSON.stringify({ error: {} }), { status: 400 }))).toBe(
      "HTTP 400",
    );
  });
});
