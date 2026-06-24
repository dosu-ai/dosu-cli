import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { mockMintTicket, mockExchangeTicket } = vi.hoisted(() => ({
  mockMintTicket: vi.fn(),
  mockExchangeTicket: vi.fn(),
}));

vi.mock("./ticket", () => ({
  mintTicket: mockMintTicket,
  exchangeTicket: mockExchangeTicket,
}));

import { startDeviceFlow } from "./device";

const MINTED = {
  ticket: "test-ticket-abc",
  expires_in: 600,
  url: "https://app.dosu.dev/cli/auth?ticket=test-ticket-abc",
};

describe("startDeviceFlow", () => {
  let consoleSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    consoleSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    mockMintTicket.mockClear().mockResolvedValue(MINTED);
    mockExchangeTicket.mockClear();
    vi.useFakeTimers();
  });

  afterEach(() => {
    consoleSpy.mockRestore();
    vi.useRealTimers();
  });

  it("prints the auth URL and waits for authorization", async () => {
    mockExchangeTicket.mockResolvedValueOnce({ status: "pending" }).mockResolvedValueOnce({
      status: "authenticated",
      access_token: "access-tok",
      refresh_token: "refresh-tok",
      expires_in: 3600,
    });

    const flowPromise = startDeviceFlow();
    await vi.advanceTimersByTimeAsync(5_000);
    await vi.advanceTimersByTimeAsync(5_000);
    const token = await flowPromise;

    const printed = consoleSpy.mock.calls.map((c: unknown[]) => c[0]).join("\n");
    expect(printed).toContain("https://app.dosu.dev/cli/auth?ticket=test-ticket-abc");
    expect(token).toEqual({
      access_token: "access-tok",
      refresh_token: "refresh-tok",
      expires_in: 3600,
    });
  });

  it("resolves immediately on first poll if already authenticated", async () => {
    mockExchangeTicket.mockResolvedValueOnce({
      status: "authenticated",
      access_token: "tok",
      refresh_token: "ref",
      expires_in: 1800,
    });

    const flowPromise = startDeviceFlow();
    await vi.advanceTimersByTimeAsync(5_000);
    const token = await flowPromise;

    expect(token.access_token).toBe("tok");
    expect(mockExchangeTicket).toHaveBeenCalledOnce();
  });

  it("uses 3600 as expires_in fallback when backend omits it", async () => {
    mockExchangeTicket.mockResolvedValueOnce({
      status: "authenticated",
      access_token: "tok",
      refresh_token: "ref",
      expires_in: undefined,
    });

    const flowPromise = startDeviceFlow();
    await vi.advanceTimersByTimeAsync(5_000);
    const token = await flowPromise;

    expect(token.expires_in).toBe(3600);
  });

  it("throws when the ticket is reported as expired", async () => {
    mockExchangeTicket.mockResolvedValueOnce({ status: "expired" });

    const flowPromise = startDeviceFlow();
    // Attach rejection handler before advancing timers to avoid unhandled-rejection warnings
    const assertion = expect(flowPromise).rejects.toThrow("Login session expired");
    await vi.advanceTimersByTimeAsync(5_000);
    await assertion;
  });

  it("throws when the deadline elapses before authentication", async () => {
    mockExchangeTicket.mockResolvedValue({ status: "pending" });

    const flowPromise = startDeviceFlow();
    const assertion = expect(flowPromise).rejects.toThrow("timed out");
    // Advance past the full expires_in (600s) with poll ticks
    await vi.advanceTimersByTimeAsync(601_000);
    await assertion;
  });

  it("throws immediately when signal is already aborted before the first poll", async () => {
    const controller = new AbortController();
    controller.abort(); // pre-aborted — fires the pre-sleep check on the first loop iteration

    const flowPromise = startDeviceFlow(controller.signal);
    await expect(flowPromise).rejects.toThrow("authentication cancelled");
    expect(mockExchangeTicket).not.toHaveBeenCalled();
  });

  it("throws when abort signal is triggered between polls", async () => {
    mockExchangeTicket.mockResolvedValue({ status: "pending" });

    const controller = new AbortController();
    const flowPromise = startDeviceFlow(controller.signal);
    const assertion = expect(flowPromise).rejects.toThrow("authentication cancelled");

    // Tick once so the loop is running, then abort
    await vi.advanceTimersByTimeAsync(5_000);
    controller.abort();
    await vi.advanceTimersByTimeAsync(5_000);
    await assertion;
  });

  it("falls back to empty string when authenticated response omits tokens", async () => {
    mockExchangeTicket.mockResolvedValueOnce({
      status: "authenticated",
      access_token: undefined,
      refresh_token: undefined,
      expires_in: 600,
    });

    const flowPromise = startDeviceFlow();
    await vi.advanceTimersByTimeAsync(5_000);
    const token = await flowPromise;

    expect(token.access_token).toBe("");
    expect(token.refresh_token).toBe("");
  });

  it("polls the correct ticket id", async () => {
    mockExchangeTicket.mockResolvedValueOnce({
      status: "authenticated",
      access_token: "a",
      refresh_token: "b",
      expires_in: 600,
    });

    const flowPromise = startDeviceFlow();
    await vi.advanceTimersByTimeAsync(5_000);
    await flowPromise;

    expect(mockExchangeTicket).toHaveBeenCalledWith("test-ticket-abc");
  });
});
