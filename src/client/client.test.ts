import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { Config } from "../config/config";
import { type FlatTestConfig, makeTestConfig } from "../config/config.test-utils";
import { Client, SessionExpiredError } from "./client";

// Mock saveConfig to avoid filesystem writes (hoisted; applies to the whole file)
vi.mock("../config/config", async () => {
  const actual = await vi.importActual("../config/config");
  return {
    ...actual,
    saveConfig: vi.fn(),
  };
});

// Mock fetch globally
const mockFetch = vi.fn();
vi.stubGlobal("fetch", mockFetch);

function makeConfig(overrides: Partial<FlatTestConfig> = {}): Config {
  return makeTestConfig({
    access_token: "test-token",
    refresh_token: "test-refresh",
    expires_at: Math.floor(Date.now() / 1000) + 3600, // 1 hour from now
    ...overrides,
  });
}

function jsonResponse(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

describe("Client", () => {
  const savedEnv: Record<string, string | undefined> = {};

  beforeAll(() => {
    for (const key of ["SUPABASE_URL", "SUPABASE_ANON_KEY", "DOSU_BACKEND_URL"]) {
      savedEnv[key] = process.env[key];
    }
    process.env.SUPABASE_URL = "https://test.supabase.co";
    process.env.SUPABASE_ANON_KEY = "test-anon-key";
    process.env.DOSU_BACKEND_URL = "https://api.test.dev";
  });

  afterAll(() => {
    for (const [key, val] of Object.entries(savedEnv)) {
      if (val !== undefined) {
        process.env[key] = val;
      } else {
        delete process.env[key];
      }
    }
  });

  beforeEach(() => {
    mockFetch.mockReset();
  });

  describe("doRequest", () => {
    it("throws if not authenticated", async () => {
      const client = new Client(makeConfig({ access_token: "" }));
      await expect(client.get("/test")).rejects.toThrow("not authenticated");
    });

    it("sends correct headers", async () => {
      mockFetch.mockResolvedValueOnce(jsonResponse({ ok: true }));
      const client = new Client(makeConfig());
      await client.get("/test");
      const [, options] = mockFetch.mock.calls[0];
      expect(options.headers["Content-Type"]).toBe("application/json");
      expect(options.headers["Supabase-Access-Token"]).toBe("test-token");
    });

    it("retries on 401 with token refresh", async () => {
      // First call: 401
      mockFetch.mockResolvedValueOnce(jsonResponse({}, 401));
      // Refresh call
      mockFetch.mockResolvedValueOnce(
        jsonResponse({
          access_token: "new-token",
          refresh_token: "new-refresh",
          expires_in: 3600,
        }),
      );
      // Retry call
      mockFetch.mockResolvedValueOnce(jsonResponse({ data: "success" }));

      const cfg = makeConfig();

      const client = new Client(cfg);
      const resp = await client.get("/test");
      expect(resp.status).toBe(200);
      expect(mockFetch).toHaveBeenCalledTimes(3); // original + refresh + retry
    });

    it("throws SessionExpiredError when refresh fails", async () => {
      mockFetch.mockResolvedValueOnce(jsonResponse({}, 401));
      mockFetch.mockResolvedValueOnce(jsonResponse({}, 400)); // refresh fails

      const client = new Client(makeConfig());
      await expect(client.get("/test")).rejects.toBeInstanceOf(SessionExpiredError);
    });

    it("pre-emptively refreshes token when locally expired before making request", async () => {
      // Refresh response
      mockFetch.mockResolvedValueOnce(
        jsonResponse({
          access_token: "refreshed-token",
          refresh_token: "refreshed-refresh",
          expires_in: 7200,
        }),
      );
      // Actual request after refresh
      mockFetch.mockResolvedValueOnce(jsonResponse({ data: "ok" }));

      const cfg = makeConfig({
        expires_at: Math.floor(Date.now() / 1000) - 100, // already expired
      });
      const client = new Client(cfg);
      const resp = await client.get("/test");

      expect(resp.status).toBe(200);
      // Should have made 2 calls: refresh + actual request
      expect(mockFetch).toHaveBeenCalledTimes(2);
      // First call should be to the refresh endpoint
      expect(mockFetch.mock.calls[0][0]).toContain("/auth/v1/token");
      // Config should be updated with new tokens
      expect(cfg.active_account?.session.access_token).toBe("refreshed-token");
      expect(cfg.active_account?.session.refresh_token).toBe("refreshed-refresh");
    });

    it("throws when refresh_token is missing and token is expired", async () => {
      const client = new Client(
        makeConfig({
          refresh_token: "",
          expires_at: Math.floor(Date.now() / 1000) - 100,
        }),
      );
      await expect(client.get("/test")).rejects.toThrow("no refresh token available");
    });
  });

  describe("HTTP methods", () => {
    it("get sends GET request", async () => {
      mockFetch.mockResolvedValueOnce(jsonResponse({}));
      const client = new Client(makeConfig());
      await client.get("/path");
      expect(mockFetch.mock.calls[0][1].method).toBe("GET");
    });

    it("post sends POST with body", async () => {
      mockFetch.mockResolvedValueOnce(jsonResponse({}));
      const client = new Client(makeConfig());
      await client.post("/path", { key: "value" });
      const [, options] = mockFetch.mock.calls[0];
      expect(options.method).toBe("POST");
      expect(options.body).toBe('{"key":"value"}');
    });

    it("put sends PUT with body", async () => {
      mockFetch.mockResolvedValueOnce(jsonResponse({}));
      const client = new Client(makeConfig());
      await client.put("/path", { x: 1 });
      expect(mockFetch.mock.calls[0][1].method).toBe("PUT");
    });

    it("delete sends DELETE request", async () => {
      mockFetch.mockResolvedValueOnce(jsonResponse({}));
      const client = new Client(makeConfig());
      await client.delete("/path");
      expect(mockFetch.mock.calls[0][1].method).toBe("DELETE");
    });
  });

  describe("doRequestRaw", () => {
    it("returns 401 without retrying or refreshing", async () => {
      mockFetch.mockResolvedValueOnce(jsonResponse({}, 401));
      const client = new Client(makeConfig());
      const resp = await client.doRequestRaw("GET", "/raw");
      expect(resp.status).toBe(401);
      // Only one call — no retry, no refresh
      expect(mockFetch).toHaveBeenCalledTimes(1);
    });
  });

  describe("getDeployments", () => {
    it("returns deployments on success", async () => {
      const deployments = [
        {
          deployment_id: "d1",
          name: "Test",
          description: "",
          provider_slug: "test",
          enabled: true,
          org_id: "o1",
          org_name: "Org",
          space_id: "s1",
        },
      ];
      mockFetch.mockResolvedValueOnce(jsonResponse(deployments));
      const client = new Client(makeConfig());
      const result = await client.getDeployments();
      expect(result).toEqual(deployments);
    });

    it("throws on non-200 response", async () => {
      mockFetch.mockResolvedValueOnce(new Response("Not Found", { status: 404 }));
      const client = new Client(makeConfig());
      await expect(client.getDeployments()).rejects.toThrow("failed to fetch deployments");
    });
  });

  describe("getOrgs", () => {
    it("returns orgs on success", async () => {
      const orgs = [{ org_id: "o1", name: "My Org" }];
      mockFetch.mockResolvedValueOnce(jsonResponse(orgs));
      const client = new Client(makeConfig());
      const result = await client.getOrgs();
      expect(result).toEqual(orgs);
    });
  });

  describe("validateAPIKey", () => {
    it("returns true for valid key", async () => {
      mockFetch.mockResolvedValueOnce(jsonResponse({}, 200));
      const client = new Client(makeConfig());
      expect(await client.validateAPIKey("key", "dep-1")).toBe(true);
    });

    it("returns false for 401", async () => {
      mockFetch.mockResolvedValueOnce(jsonResponse({}, 401));
      const client = new Client(makeConfig());
      expect(await client.validateAPIKey("key", "dep-1")).toBe(false);
    });

    it("returns false for 403", async () => {
      mockFetch.mockResolvedValueOnce(jsonResponse({}, 403));
      const client = new Client(makeConfig());
      expect(await client.validateAPIKey("key", "dep-1")).toBe(false);
    });

    it("returns true on network error (optimistic)", async () => {
      mockFetch.mockRejectedValueOnce(new Error("network failure"));
      const client = new Client(makeConfig());
      expect(await client.validateAPIKey("key", "dep-1")).toBe(true);
    });
  });

  describe("refreshToken", () => {
    it("sends apikey header to Supabase refresh endpoint", async () => {
      mockFetch.mockResolvedValueOnce(
        jsonResponse({
          access_token: "new-tok",
          refresh_token: "new-ref",
          expires_in: 3600,
        }),
      );

      const client = new Client(makeConfig());
      await client.refreshToken();

      const [url, options] = mockFetch.mock.calls[0];
      expect(url).toContain("/auth/v1/token");
      expect(options.headers).toHaveProperty("apikey");
      expect(options.headers.apikey).toBeTruthy();
    });
  });

  describe("createAPIKey", () => {
    it("returns API key on success", async () => {
      const response = { api_key: "key-123", id: "id-1", name: "cli", key_prefix: "key" };
      mockFetch.mockResolvedValueOnce(jsonResponse(response, 201));
      const client = new Client(makeConfig());
      const result = await client.createAPIKey("dep-1", "cli");
      expect(result.api_key).toBe("key-123");
    });

    it("throws on failure", async () => {
      // First call returns 403, triggers refresh attempt
      mockFetch.mockResolvedValueOnce(new Response("Forbidden", { status: 403 }));
      // Refresh succeeds
      mockFetch.mockResolvedValueOnce(
        jsonResponse({ access_token: "new", refresh_token: "new", expires_in: 3600 }),
      );
      // Retry still returns 500
      mockFetch.mockResolvedValueOnce(new Response("Server Error", { status: 500 }));

      const client = new Client(makeConfig());
      await expect(client.createAPIKey("dep-1", "cli")).rejects.toThrow("failed to create API key");
    });
  });

  describe("api-key requests", () => {
    it("postWithApiKey sends the X-Dosu-API-Key header and JSON body (no OAuth token)", async () => {
      mockFetch.mockResolvedValueOnce(jsonResponse({ ticket_id: "t1" }, 202));
      const client = new Client(makeConfig({ api_key: "key-abc" }));
      const resp = await client.postWithApiKey("/v1/tickets/knowledge", { prompt: "p" });
      expect(resp.status).toBe(202);
      const [url, options] = mockFetch.mock.calls[0];
      expect(url).toBe("https://api.test.dev/v1/tickets/knowledge");
      expect(options.method).toBe("POST");
      expect(options.headers["X-Dosu-API-Key"]).toBe("key-abc");
      expect(options.headers["Supabase-Access-Token"]).toBeUndefined();
      expect(JSON.parse(options.body)).toEqual({ prompt: "p" });
    });

    it("getWithApiKey sends the header, no body, and surfaces 401 without refreshing", async () => {
      mockFetch.mockResolvedValueOnce(jsonResponse({}, 401));
      const client = new Client(makeConfig({ api_key: "key-abc" }));
      const resp = await client.getWithApiKey("/v1/tickets/knowledge/t1");
      expect(resp.status).toBe(401); // surfaced as-is — no OAuth refresh/retry
      expect(mockFetch).toHaveBeenCalledTimes(1);
      const [, options] = mockFetch.mock.calls[0];
      expect(options.method).toBe("GET");
      expect(options.body).toBeUndefined();
      expect(options.headers["X-Dosu-API-Key"]).toBe("key-abc");
    });

    it("throws when no API key is configured", async () => {
      const client = new Client(makeConfig({ api_key: undefined }));
      await expect(client.postWithApiKey("/x", {})).rejects.toThrow("no API key available");
      expect(mockFetch).not.toHaveBeenCalled();
    });
  });
});
