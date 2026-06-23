import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Config } from "../config/config";
import { createTypedClient } from "./trpc";

// Mock fetch globally
const mockFetch = vi.fn();
vi.stubGlobal("fetch", mockFetch);
const mockGetWebAppURL = vi.fn(() => "https://app.test.dev");

vi.mock("../debug/logger", () => ({
  logger: { debug: vi.fn(), error: vi.fn(), info: vi.fn(), warn: vi.fn() },
}));

vi.mock("../config/constants", () => ({
  getWebAppURL: () => mockGetWebAppURL(),
}));

const { mockIsTokenExpired } = vi.hoisted(() => ({
  mockIsTokenExpired: vi.fn<(cfg: Config) => boolean>().mockReturnValue(false),
}));
vi.mock("../config/config", () => ({
  isTokenExpired: (cfg: Config) => mockIsTokenExpired(cfg),
}));

const { mockRefreshToken } = vi.hoisted(() => ({
  mockRefreshToken: vi.fn(),
}));
vi.mock("./client", () => ({
  Client: vi.fn().mockImplementation(function () {
    return { refreshToken: mockRefreshToken };
  }),
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

/** Build a minimal tRPC-compatible single response (httpLink, not batch). */
function trpcOk(data: unknown = {}, status = 200): Response {
  return new Response(JSON.stringify({ result: { type: "data", data: { json: data } } }), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function trpcError(status: number): Response {
  return new Response(JSON.stringify({ error: { message: "unauthorized", code: -32600 } }), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

describe("createTypedClient", () => {
  beforeEach(() => {
    mockFetch.mockReset();
    mockGetWebAppURL.mockReset();
    mockGetWebAppURL.mockReturnValue("https://app.test.dev");
    mockIsTokenExpired.mockReset().mockReturnValue(false);
    mockRefreshToken.mockReset().mockResolvedValue(undefined);
  });

  it("throws when DOSU_WEB_APP_URL is empty", () => {
    mockGetWebAppURL.mockReturnValueOnce("");
    expect(() => createTypedClient(makeConfig())).toThrow("Web app URL not configured");
  });

  it("throws when access_token is missing", () => {
    expect(() => createTypedClient(makeConfig({ access_token: "" }))).toThrow("Not authenticated");
  });

  it("returns a tRPC client", () => {
    const client = createTypedClient(makeConfig());
    expect(client).toBeDefined();
  });

  describe("token refresh via headers()", () => {
    it("refreshes token proactively when isTokenExpired returns true", async () => {
      const cfg = makeConfig();
      mockIsTokenExpired.mockReturnValue(true);
      mockRefreshToken.mockImplementation(async () => {
        cfg.access_token = "refreshed";
      });
      mockFetch.mockResolvedValue(trpcOk({ ok: true }));

      const client = createTypedClient(cfg);

      // Trigger a request — this invokes the headers() closure
      // biome-ignore lint/suspicious/noExplicitAny: testing dynamic tRPC proxy
      await (client as any).thread.list.query({ space_id: "s1" });

      expect(mockRefreshToken).toHaveBeenCalledOnce();
      // Verify fetch was called with the refreshed token
      const [, fetchOpts] = mockFetch.mock.calls[0];
      expect(fetchOpts.headers["Supabase-Access-Token"]).toBe("refreshed");
    });

    it("throws session expired when proactive refresh fails", async () => {
      mockIsTokenExpired.mockReturnValue(true);
      mockRefreshToken.mockRejectedValue(new Error("network error"));

      const client = createTypedClient(makeConfig());

      await expect(
        // biome-ignore lint/suspicious/noExplicitAny: testing dynamic tRPC proxy
        (client as any).thread.list.query({ space_id: "s1" }),
      ).rejects.toThrow("session expired");
    });
  });

  describe("token refresh via fetch() wrapper", () => {
    it("retries on 401 with refreshed token", async () => {
      const cfg = makeConfig({ access_token: "old" });
      mockRefreshToken.mockImplementation(async () => {
        cfg.access_token = "new_token";
      });
      // First call: 401, retry: success
      mockFetch.mockResolvedValueOnce(trpcError(401));
      mockFetch.mockResolvedValueOnce(trpcOk({ retried: true }));

      const client = createTypedClient(cfg);

      // biome-ignore lint/suspicious/noExplicitAny: testing dynamic tRPC proxy
      await (client as any).thread.list.query({ space_id: "s1" });

      expect(mockRefreshToken).toHaveBeenCalledOnce();
      expect(mockFetch).toHaveBeenCalledTimes(2);
      // Verify retry used the new token
      const [, retryOpts] = mockFetch.mock.calls[1];
      expect(retryOpts.headers["Supabase-Access-Token"]).toBe("new_token");
    });

    it("returns original response when 401 refresh fails", async () => {
      mockRefreshToken.mockRejectedValue(new Error("refresh failed"));
      mockFetch.mockResolvedValue(trpcError(401));

      const client = createTypedClient(makeConfig());

      await expect(
        // biome-ignore lint/suspicious/noExplicitAny: testing dynamic tRPC proxy
        (client as any).thread.list.query({ space_id: "s1" }),
      ).rejects.toThrow();

      expect(mockRefreshToken).toHaveBeenCalledOnce();
      // Should NOT have retried — only 1 fetch call
      expect(mockFetch).toHaveBeenCalledTimes(1);
    });
  });
});
