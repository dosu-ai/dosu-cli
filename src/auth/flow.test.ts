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

vi.mock("../debug/logger", () => ({
  logger: {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    init: vi.fn(),
    getLogPath: vi.fn(() => "/tmp/test-debug.log"),
  },
}));

import { startOAuthFlow } from "./flow";

function createMockServer(): CallbackServer {
  return {
    port: 12345,
    close: mockClose,
  };
}

/**
 * Deterministically wait until the flow under test has opened the browser
 * and armed its timeout/abort race. Fixed-duration sleeps flaked on slow CI
 * runners (coverage-instrumented dynamic import of "open" can take >10ms):
 * the assertion then saw zero open() calls, and the leaked unresolved flow
 * created its 8-minute timer under a later test's fake timers, cascading
 * into that test's timer-count assertion.
 */
async function flowReady(): Promise<void> {
  await vi.waitFor(() => expect(mockOpenDefault).toHaveBeenCalledOnce());
  // open() resolving hands control back to the flow on the microtask queue;
  // a macrotask barrier guarantees the timeout/abort race is armed before
  // the test acts (e.g. fires an abort the flow must be listening for).
  await new Promise((r) => setImmediate(r));
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
    await flowReady();

    resolveToken(expectedToken);

    const result = await flowPromise;
    expect(result).toEqual({ browserOpened: true, token: expectedToken });
  });

  it("closes the server after successful completion", async () => {
    const token: TokenResponse = {
      access_token: "tok",
      refresh_token: "ref",
      expires_in: 3600,
    };

    const flowPromise = startOAuthFlow();
    await flowReady();

    resolveToken(token);
    const result = await flowPromise;
    expect(result).toMatchObject({ browserOpened: true });

    expect(mockClose).toHaveBeenCalledOnce();
  });

  it("closes the server when tokenPromise rejects", async () => {
    const flowPromise = startOAuthFlow();
    await flowReady();

    rejectToken(new Error("something went wrong"));

    const error = await flowPromise.catch((e: Error) => e);
    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).toBe("something went wrong");
    expect(mockClose).toHaveBeenCalledOnce();
  });

  it("rejects when abort signal is triggered", async () => {
    const controller = new AbortController();

    const flowPromise = startOAuthFlow(controller.signal);
    await flowReady();

    controller.abort();

    const error = await flowPromise.catch((e: Error) => e);
    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).toBe("authentication cancelled");
    expect(mockClose).toHaveBeenCalledOnce();
  });

  it("returns browserOpened:false and closes the server when open() throws", async () => {
    mockOpenDefault.mockRejectedValueOnce(new Error("Executable not found in $PATH: xdg-open"));

    const result = await startOAuthFlow();

    expect(result).toEqual({ browserOpened: false });
    expect(mockClose).toHaveBeenCalledOnce();
  });

  it("opens the browser with the correct auth URL", async () => {
    const flowPromise = startOAuthFlow();
    await flowReady();

    expect(mockOpenDefault).toHaveBeenCalledOnce();
    const calledURL = mockOpenDefault.mock.calls[0]?.[0] as string;
    expect(calledURL).toBe(
      "https://app.dosu.dev/cli/auth?callback=http%3A%2F%2Flocalhost%3A12345%2Fcallback",
    );

    resolveToken({ access_token: "a", refresh_token: "r", expires_in: 1 });
    const r = await flowPromise;
    expect(r).toMatchObject({ browserOpened: true });
  });

  it("invokes onAuthURL with the auth URL once the browser opens", async () => {
    const onAuthURL = vi.fn();

    const flowPromise = startOAuthFlow(undefined, "/cli/auth", {}, onAuthURL);
    await flowReady();

    expect(onAuthURL).toHaveBeenCalledExactlyOnceWith(
      "https://app.dosu.dev/cli/auth?callback=http%3A%2F%2Flocalhost%3A12345%2Fcallback",
    );

    resolveToken({ access_token: "a", refresh_token: "r", expires_in: 1 });
    const r = await flowPromise;
    expect(r).toMatchObject({ browserOpened: true });
  });

  it("does not invoke onAuthURL when the browser fails to open", async () => {
    mockOpenDefault.mockRejectedValueOnce(new Error("Executable not found in $PATH: xdg-open"));
    const onAuthURL = vi.fn();

    const result = await startOAuthFlow(undefined, "/cli/auth", {}, onAuthURL);

    // The callback server is closed on this path — the URL would be a dead
    // link, and callers fall back to the device flow instead.
    expect(result).toEqual({ browserOpened: false });
    expect(onAuthURL).not.toHaveBeenCalled();
  });

  it("includes extra auth URL params", async () => {
    const flowPromise = startOAuthFlow(undefined, "/cli/auth", {
      onboarding_run_id: "run-123",
    });
    await flowReady();

    const calledURL = mockOpenDefault.mock.calls[0]?.[0] as string;
    expect(calledURL).toContain("onboarding_run_id=run-123");

    resolveToken({ access_token: "a", refresh_token: "r", expires_in: 1 });
    const r = await flowPromise;
    expect(r).toMatchObject({ browserOpened: true });
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

  it("rejects after 8 minutes with retry guidance", async () => {
    const setTimeoutSpy = vi.spyOn(globalThis, "setTimeout").mockImplementation((callback) => {
      queueMicrotask(() => {
        if (typeof callback === "function") callback();
      });
      return 1 as unknown as ReturnType<typeof setTimeout>;
    });

    const flowPromise = startOAuthFlow();

    await expect(flowPromise).rejects.toThrow(
      "Authentication did not complete within 8 minutes. The OAuth state may have expired",
    );
    expect(setTimeoutSpy).toHaveBeenCalledWith(expect.any(Function), 8 * 60 * 1000);
    expect(mockClose).toHaveBeenCalledOnce();

    setTimeoutSpy.mockRestore();
  });

  it("does not print anything and returns immediately when browser cannot be opened", async () => {
    mockOpenDefault.mockRejectedValueOnce(new Error("Executable not found in $PATH: xdg-open"));
    const consoleSpy = vi.spyOn(console, "log").mockImplementation(() => {});

    const result = await startOAuthFlow();

    expect(result).toEqual({ browserOpened: false });
    // No URL printed — the caller (cli.ts / device flow) handles messaging
    expect(consoleSpy).not.toHaveBeenCalled();
    consoleSpy.mockRestore();
  });

  it("uses the configured web app URL for building the auth URL", async () => {
    mockGetWebAppURL.mockReturnValue("http://localhost:3001");

    const flowPromise = startOAuthFlow();
    await flowReady();

    expect(mockOpenDefault).toHaveBeenCalledOnce();
    const calledURL = mockOpenDefault.mock.calls[0]?.[0] as string;
    expect(calledURL).toContain("http://localhost:3001/cli/auth?");

    resolveToken({ access_token: "a", refresh_token: "r", expires_in: 1 });
    const r = await flowPromise;
    expect(r).toMatchObject({ browserOpened: true });
  });
});
