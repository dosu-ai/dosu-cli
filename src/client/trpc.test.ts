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

vi.mock("../config/config", () => ({
  isTokenExpired: () => false,
}));

vi.mock("./client", () => ({
  Client: vi.fn().mockImplementation(() => ({
    refreshToken: vi.fn(),
  })),
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

describe("createTypedClient", () => {
  beforeEach(() => {
    mockFetch.mockReset();
    mockGetWebAppURL.mockReset();
    mockGetWebAppURL.mockReturnValue("https://app.test.dev");
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
});
