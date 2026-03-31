import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { CallbackServer, TokenResponse } from "./server";

const { mockOpenDefault, mockClose, mockStartCallbackServer, mockGetWebAppURL } = vi.hoisted(
  () => ({
    mockOpenDefault: vi.fn().mockResolvedValue(undefined),
    mockClose: vi.fn(),
    mockStartCallbackServer: vi.fn(),
    mockGetWebAppURL: vi.fn(() => "https://app.dosu.dev"),
  }),
);

vi.mock("open", () => ({
  default: mockOpenDefault,
}));

vi.mock("./server", () => ({
  startCallbackServer: mockStartCallbackServer,
}));

vi.mock("../config/constants", () => ({
  getWebAppURL: mockGetWebAppURL,
}));

import { startOAuthFlow } from "./flow";

function createMockServer(): CallbackServer {
  return {
    port: 12345,
    close: mockClose,
  };
}

describe("startOAuthFlow", () => {
  let mockServer: CallbackServer;
  let resolveToken: (token: TokenResponse) => void;
  let rejectToken: (err: Error) => void;

  afterEach(() => {
    vi.useRealTimers();
  });

  beforeEach(() => {
    mockOpenDefault.mockClear().mockResolvedValue(undefined);
    mockClose.mockClear();
    mockGetWebAppURL.mockClear().mockReturnValue("https://app.dosu.dev");

    mockServer = createMockServer();

    const tokenPromise = new Promise<TokenResponse>((resolve, reject) => {
      resolveToken = resolve;
      rejectToken = reject;
    });

    mockStartCallbackServer.mockClear().mockResolvedValue({
      server: mockServer,
      tokenPromise,
    });
  });

  it("resolves with the token when tokenPromise resolves", async () => {
    const expectedToken: TokenResponse = {
      access_token: "test-access-token",
      refresh_token: "test-refresh-token",
      expires_in: 3600,
    };

    const flowPromise = startOAuthFlow();

    // Let the async setup run
    await new Promise((r) => setTimeout(r, 10));

    resolveToken(expectedToken);

    const result = await flowPromise;
    expect(result).toEqual(expectedToken);
  });

  it("closes the server after successful completion", async () => {
    const token: TokenResponse = {
      access_token: "tok",
      refresh_token: "ref",
      expires_in: 3600,
    };

    const flowPromise = startOAuthFlow();
    await new Promise((r) => setTimeout(r, 10));

    resolveToken(token);
    await flowPromise;

    expect(mockClose).toHaveBeenCalledOnce();
  });

  it("closes the server when tokenPromise rejects", async () => {
    const flowPromise = startOAuthFlow();
    await new Promise((r) => setTimeout(r, 10));

    rejectToken(new Error("something went wrong"));

    const error = await flowPromise.catch((e: Error) => e);
    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).toBe("something went wrong");
    expect(mockClose).toHaveBeenCalledOnce();
  });

  it("rejects when abort signal is triggered", async () => {
    const controller = new AbortController();

    const flowPromise = startOAuthFlow(controller.signal);
    await new Promise((r) => setTimeout(r, 10));

    controller.abort();

    const error = await flowPromise.catch((e: Error) => e);
    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).toBe("authentication cancelled");
    expect(mockClose).toHaveBeenCalledOnce();
  });

  it("opens the browser with the correct auth URL", async () => {
    const flowPromise = startOAuthFlow();
    await new Promise((r) => setTimeout(r, 10));

    expect(mockOpenDefault).toHaveBeenCalledOnce();
    const calledURL = mockOpenDefault.mock.calls[0]?.[0] as string;
    expect(calledURL).toBe(
      "https://app.dosu.dev/cli/auth?callback=http%3A%2F%2Flocalhost%3A12345%2Fcallback",
    );

    resolveToken({ access_token: "a", refresh_token: "r", expires_in: 1 });
    await flowPromise;
  });

  it("clears the timeout timer after successful token receipt", async () => {
    vi.useFakeTimers();

    const token: TokenResponse = {
      access_token: "tok",
      refresh_token: "ref",
      expires_in: 3600,
    };

    const flowPromise = startOAuthFlow();
    await vi.advanceTimersByTimeAsync(10);

    resolveToken(token);
    await flowPromise;

    // The 5-minute timeout should have been cleared — no lingering timers
    expect(vi.getTimerCount()).toBe(0);
  });

  it("uses the configured web app URL for building the auth URL", async () => {
    mockGetWebAppURL.mockReturnValue("http://localhost:3001");

    const flowPromise = startOAuthFlow();
    await new Promise((r) => setTimeout(r, 10));

    expect(mockOpenDefault).toHaveBeenCalledOnce();
    const calledURL = mockOpenDefault.mock.calls[0]?.[0] as string;
    expect(calledURL).toContain("http://localhost:3001/cli/auth?");

    resolveToken({ access_token: "a", refresh_token: "r", expires_in: 1 });
    await flowPromise;
  });
});
