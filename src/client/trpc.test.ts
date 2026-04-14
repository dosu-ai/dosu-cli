import superjson from "superjson";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { Config } from "../config/config";
import { TrpcClient, TrpcError, createTypedClient } from "./trpc";

// Mock fetch globally (same pattern as client.test.ts)
const mockFetch = vi.fn();
vi.stubGlobal("fetch", mockFetch);

// Mock logger to avoid debug output
vi.mock("../debug/logger", () => ({
  logger: { debug: vi.fn(), error: vi.fn(), info: vi.fn(), warn: vi.fn() },
}));

function makeConfig(overrides: Partial<Config> = {}): Config {
  return {
    access_token: "t",
    refresh_token: "r",
    expires_at: 0,
    api_key: "sk_user_test_key_123",
    ...overrides,
  };
}

/** Wrap data in a real tRPC success envelope using superjson.serialize. */
function trpcSuccess(data: unknown): Response {
  return new Response(JSON.stringify({ result: { data: superjson.serialize(data) } }), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });
}

/** Create a tRPC error envelope response. */
function trpcErrorResponse(message?: string, dataCode?: string, status = 200): Response {
  const error: Record<string, unknown> = {};
  if (message !== undefined) error.message = message;
  if (dataCode !== undefined) error.data = { code: dataCode };
  return new Response(JSON.stringify({ error }), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

describe("TrpcClient", () => {
  const savedEnv: Record<string, string | undefined> = {};

  beforeAll(() => {
    savedEnv.DOSU_WEB_APP_URL = process.env.DOSU_WEB_APP_URL;
    process.env.DOSU_WEB_APP_URL = "https://app.test.dev";
  });

  afterAll(() => {
    if (savedEnv.DOSU_WEB_APP_URL !== undefined) {
      process.env.DOSU_WEB_APP_URL = savedEnv.DOSU_WEB_APP_URL;
    } else {
      delete process.env.DOSU_WEB_APP_URL;
    }
  });

  beforeEach(() => {
    mockFetch.mockReset();
  });

  // ── constructor ──

  describe("constructor", () => {
    it("throws when DOSU_WEB_APP_URL is empty", () => {
      const orig = process.env.DOSU_WEB_APP_URL;
      process.env.DOSU_WEB_APP_URL = "";
      try {
        expect(() => new TrpcClient(makeConfig())).toThrow("Web app URL not configured");
      } finally {
        process.env.DOSU_WEB_APP_URL = orig;
      }
    });

    it("throws when api_key is missing from config", () => {
      expect(() => new TrpcClient(makeConfig({ api_key: undefined }))).toThrow("API key not found");
    });
  });

  // ── query ──

  describe("query", () => {
    it("sends GET to correct URL with API key header", async () => {
      mockFetch.mockResolvedValueOnce(trpcSuccess({ ok: true }));
      const client = new TrpcClient(makeConfig());
      await client.query("thread.list");

      const [url, options] = mockFetch.mock.calls[0];
      expect(url).toBe("https://app.test.dev/api/trpc/thread.list");
      expect(options.method).toBe("GET");
      expect(options.headers["X-Dosu-API-Key"]).toBe("sk_user_test_key_123");
      // GET should NOT have Content-Type
      expect(options.headers["Content-Type"]).toBeUndefined();
    });

    it("serializes input as SuperJSON with exact {json, meta} shape", async () => {
      mockFetch.mockResolvedValueOnce(trpcSuccess({}));
      const client = new TrpcClient(makeConfig());
      const input = { space_id: "s1", limit: 20 };
      await client.query("thread.list", input);

      const url = new URL(mockFetch.mock.calls[0][0]);
      const inputParam = url.searchParams.get("input");
      expect(inputParam).not.toBeNull();

      // Decode and verify exact SuperJSON structure
      const decoded = JSON.parse(inputParam!);
      const expected = superjson.serialize(input);
      expect(decoded).toEqual(expected);
      expect(decoded.json).toEqual({ space_id: "s1", limit: 20 });
    });

    it("omits ?input= when input is undefined", async () => {
      mockFetch.mockResolvedValueOnce(trpcSuccess({}));
      const client = new TrpcClient(makeConfig());
      await client.query("thread.list");

      const url = mockFetch.mock.calls[0][0] as string;
      expect(url).not.toContain("?input=");
    });

    it("URL-encodes special characters in input", async () => {
      mockFetch.mockResolvedValueOnce(trpcSuccess({}));
      const client = new TrpcClient(makeConfig());
      await client.query("search.getMentions", { query: "a&b=c#d 中文" });

      const url = mockFetch.mock.calls[0][0] as string;
      // URL should NOT contain raw & or = or # (they'd break URL parsing)
      const afterQuestion = url.split("?input=")[1];
      expect(afterQuestion).toBeDefined();
      expect(afterQuestion).not.toContain("&b=c");
      // Decoding should recover the original input
      const decoded = JSON.parse(decodeURIComponent(afterQuestion));
      expect(decoded.json.query).toBe("a&b=c#d 中文");
    });

    it("deserializes Date type via SuperJSON round-trip", async () => {
      const testDate = new Date("2024-06-15T12:00:00Z");
      mockFetch.mockResolvedValueOnce(trpcSuccess({ created: testDate, name: "test" }));
      const client = new TrpcClient(makeConfig());
      const result = await client.query<{ created: Date; name: string }>("test.get");

      expect(result.created).toBeInstanceOf(Date);
      expect(result.created.toISOString()).toBe("2024-06-15T12:00:00.000Z");
      expect(result.name).toBe("test");
    });

    it("handles plain JSON response without meta", async () => {
      // Some tRPC responses have no meta (no special types)
      const resp = new Response(JSON.stringify({ result: { data: { json: { id: "123" } } } }), {
        status: 200,
      });
      mockFetch.mockResolvedValueOnce(resp);
      const client = new TrpcClient(makeConfig());
      const result = await client.query<{ id: string }>("test.get");
      expect(result.id).toBe("123");
    });
  });

  // ── mutate ──

  describe("mutate", () => {
    it("sends POST with correct headers and SuperJSON body", async () => {
      mockFetch.mockResolvedValueOnce(trpcSuccess({ success: true }));
      const client = new TrpcClient(makeConfig());
      const input = { id: "thread-1" };
      await client.mutate("thread.archive", input);

      const [url, options] = mockFetch.mock.calls[0];
      expect(url).toBe("https://app.test.dev/api/trpc/thread.archive");
      expect(options.method).toBe("POST");
      expect(options.headers["Content-Type"]).toBe("application/json");
      expect(options.headers["X-Dosu-API-Key"]).toBe("sk_user_test_key_123");

      // Verify body is JSON.stringify(superjson.serialize(input))
      const body = JSON.parse(options.body);
      expect(body).toEqual(superjson.serialize(input));
    });

    it("sends undefined body when no input", async () => {
      mockFetch.mockResolvedValueOnce(trpcSuccess({ ok: true }));
      const client = new TrpcClient(makeConfig());
      await client.mutate("thread.archive");

      const options = mockFetch.mock.calls[0][1];
      expect(options.body).toBeUndefined();
    });
  });

  // ── error handling ──

  describe("error handling", () => {
    it("throws PARSE_ERROR with procedure name on non-JSON response", async () => {
      const resp = new Response("Internal Server Error", { status: 500 });
      mockFetch.mockResolvedValueOnce(resp);
      const client = new TrpcClient(makeConfig());

      const err = (await client.query("org.info").catch((e: unknown) => e)) as TrpcError;
      expect(err).toBeInstanceOf(TrpcError);
      expect(err.code).toBe("PARSE_ERROR");
      expect(err.message).toContain("org.info");
      expect(err.message).toContain("Internal Server Error");
    });

    it("parses tRPC error envelope correctly", async () => {
      mockFetch.mockResolvedValueOnce(trpcErrorResponse("Not authorized", "UNAUTHORIZED"));
      const client = new TrpcClient(makeConfig());

      const err = (await client.query("secret.get").catch((e: unknown) => e)) as TrpcError;
      expect(err).toBeInstanceOf(TrpcError);
      expect(err.code).toBe("UNAUTHORIZED");
      expect(err.message).toBe("Not authorized");
    });

    it("defaults to INTERNAL_SERVER_ERROR when data.code is missing", async () => {
      mockFetch.mockResolvedValueOnce(
        new Response(JSON.stringify({ error: { message: "Oops" } }), { status: 200 }),
      );
      const client = new TrpcClient(makeConfig());

      const err = (await client.query("broken.get").catch((e: unknown) => e)) as TrpcError;
      expect(err).toBeInstanceOf(TrpcError);
      expect(err.code).toBe("INTERNAL_SERVER_ERROR");
      expect(err.message).toBe("Oops");
    });

    it('defaults to "Unknown error" when message is missing', async () => {
      mockFetch.mockResolvedValueOnce(new Response(JSON.stringify({ error: {} }), { status: 200 }));
      const client = new TrpcClient(makeConfig());

      const err = (await client.query("broken.get").catch((e: unknown) => e)) as TrpcError;
      expect(err.message).toBe("Unknown error");
    });

    it.each([
      ["result without data", { result: {} }],
      ["empty object", {}],
    ])("throws EMPTY_RESPONSE for %s", async (_label, body) => {
      mockFetch.mockResolvedValueOnce(new Response(JSON.stringify(body), { status: 200 }));
      const client = new TrpcClient(makeConfig());

      const err = (await client.query("test.get").catch((e: unknown) => e)) as TrpcError;
      expect(err).toBeInstanceOf(TrpcError);
      expect(err.code).toBe("EMPTY_RESPONSE");
    });

    it("throws EMPTY_RESPONSE when result.data is null", async () => {
      mockFetch.mockResolvedValueOnce(
        new Response(JSON.stringify({ result: { data: null } }), { status: 200 }),
      );
      const client = new TrpcClient(makeConfig());

      const err = (await client.query("test.get").catch((e: unknown) => e)) as TrpcError;
      expect(err).toBeInstanceOf(TrpcError);
      expect(err.code).toBe("EMPTY_RESPONSE");
    });
  });

  // ── timeout ──

  describe("timeout", () => {
    it("passes AbortSignal to fetch for timeout control", async () => {
      mockFetch.mockResolvedValueOnce(trpcSuccess({ ok: true }));
      const client = new TrpcClient(makeConfig());
      await client.query("test.get");

      // Verify that an AbortSignal was passed to fetch
      const options = mockFetch.mock.calls[0][1];
      expect(options.signal).toBeInstanceOf(AbortSignal);
    });

    it("clears timeout after successful request (no timer leak)", async () => {
      const clearTimeoutSpy = vi.spyOn(globalThis, "clearTimeout");
      mockFetch.mockResolvedValueOnce(trpcSuccess({ ok: true }));

      const client = new TrpcClient(makeConfig());
      await client.query("fast.get");

      expect(clearTimeoutSpy).toHaveBeenCalled();
      clearTimeoutSpy.mockRestore();
    });
  });

  // ── TrpcError class ──

  describe("TrpcError", () => {
    it("has correct name, code, message and is instanceof Error", () => {
      const err = new TrpcError("test message", "TEST_CODE");
      expect(err).toBeInstanceOf(Error);
      expect(err).toBeInstanceOf(TrpcError);
      expect(err.name).toBe("TrpcError");
      expect(err.code).toBe("TEST_CODE");
      expect(err.message).toBe("test message");
    });
  });

  // ── createTypedClient ──

  describe("createTypedClient", () => {
    it("throws when DOSU_WEB_APP_URL is empty", () => {
      const orig = process.env.DOSU_WEB_APP_URL;
      process.env.DOSU_WEB_APP_URL = "";
      try {
        expect(() => createTypedClient(makeConfig())).toThrow("Web app URL not configured");
      } finally {
        process.env.DOSU_WEB_APP_URL = orig;
      }
    });

    it("throws when api_key is missing", () => {
      expect(() => createTypedClient(makeConfig({ api_key: undefined }))).toThrow(
        "API key not found",
      );
    });

    it("returns a tRPC client", () => {
      const client = createTypedClient(makeConfig());
      expect(client).toBeDefined();
    });
  });
});
