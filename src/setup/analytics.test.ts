import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Config } from "../config/config";

const { mockCreateTypedClient, mockCreateTRPCClient, mockDebug, mockGetWebAppURL, mockHttpLink } =
  vi.hoisted(() => ({
    mockCreateTypedClient: vi.fn(),
    mockCreateTRPCClient: vi.fn(),
    mockDebug: vi.fn(),
    mockGetWebAppURL: vi.fn(),
    mockHttpLink: vi.fn((opts: unknown) => ({ type: "httpLink", opts })),
  }));

vi.mock("../client/trpc", () => ({
  createTypedClient: mockCreateTypedClient,
}));

vi.mock("@trpc/client", () => ({
  createTRPCClient: mockCreateTRPCClient,
  httpLink: mockHttpLink,
}));

vi.mock("../config/constants", () => ({
  getWebAppURL: mockGetWebAppURL,
}));

vi.mock("../debug/logger", () => ({
  logger: { debug: mockDebug },
}));

import { trackCliOnboardingEvent, trackCliOnboardingPreAuthEvent } from "./analytics";

const mutate = vi.fn();

function makeConfig(overrides: Partial<Config> = {}): Config {
  return {
    access_token: "token",
    refresh_token: "refresh",
    expires_at: 0,
    org_id: "org-1",
    deployment_id: "dep-1",
    space_id: "space-1",
    ...overrides,
  };
}

function mockTrackingClient() {
  const client = {
    user: {
      trackCliOnboardingEvent: { mutate },
      trackCliOnboardingPreAuthEvent: { mutate },
    },
  };
  mockCreateTypedClient.mockReturnValue(client);
  mockCreateTRPCClient.mockReturnValue(client);
  return client;
}

describe("setup analytics", () => {
  beforeEach(() => {
    vi.useRealTimers();
    mutate.mockReset().mockResolvedValue(undefined);
    mockCreateTypedClient.mockReset();
    mockCreateTRPCClient.mockReset();
    mockDebug.mockReset();
    mockGetWebAppURL.mockReset().mockReturnValue("https://app.test.dev");
    mockHttpLink.mockClear();
    mockTrackingClient();
  });

  it("skips authenticated tracking when access_token is missing", async () => {
    await trackCliOnboardingEvent(
      makeConfig({ access_token: "" }),
      "run-1",
      "cli_onboarding_started",
    );

    expect(mockCreateTypedClient).not.toHaveBeenCalled();
    expect(mutate).not.toHaveBeenCalled();
  });

  it("tracks authenticated onboarding events with base and custom properties", async () => {
    await trackCliOnboardingEvent(
      makeConfig({ mode: "oss" }),
      "run-1",
      "cli_onboarding_completed",
      {
        completed_mcp: true,
      },
    );

    expect(mockCreateTypedClient).toHaveBeenCalledWith(
      expect.objectContaining({ access_token: "token" }),
    );
    expect(mutate).toHaveBeenCalledWith({
      event: "cli_onboarding_completed",
      properties: expect.objectContaining({
        onboarding_run_id: "run-1",
        install_channel: "npm",
        mode: "oss",
        org_id: "org-1",
        deployment_id: "dep-1",
        space_id: "space-1",
        completed_mcp: true,
      }),
    });
  });

  it("logs and swallows authenticated tracking failures", async () => {
    mutate.mockRejectedValueOnce("network down");

    await expect(
      trackCliOnboardingEvent(makeConfig(), "run-1", "cli_onboarding_failed"),
    ).resolves.toBeUndefined();

    expect(mockDebug).toHaveBeenCalledWith(
      "setup",
      "CLI onboarding analytics failed: cli_onboarding_failed: network down",
    );
  });

  it("logs Error instances from authenticated tracking failures", async () => {
    mutate.mockRejectedValueOnce(new Error("request failed"));

    await expect(
      trackCliOnboardingEvent(makeConfig(), "run-1", "cli_onboarding_failed"),
    ).resolves.toBeUndefined();

    expect(mockDebug).toHaveBeenCalledWith(
      "setup",
      "CLI onboarding analytics failed: cli_onboarding_failed: request failed",
    );
  });

  it("tracks pre-auth events through the anonymous client", async () => {
    await trackCliOnboardingPreAuthEvent("run-2", "cli_onboarding_auth_started", {
      source: "setup",
    });

    expect(mockHttpLink).toHaveBeenCalledWith(
      expect.objectContaining({ url: "https://app.test.dev/api/trpc" }),
    );
    expect(mockCreateTRPCClient).toHaveBeenCalledWith({
      links: [expect.objectContaining({ type: "httpLink" })],
    });
    expect(mutate).toHaveBeenCalledWith({
      event: "cli_onboarding_auth_started",
      onboarding_run_id: "run-2",
      properties: expect.objectContaining({
        install_channel: "npm",
        mode: "cloud",
        source: "setup",
      }),
    });
  });

  it("logs and swallows pre-auth client setup failures", async () => {
    mockGetWebAppURL.mockReturnValueOnce("");

    await expect(
      trackCliOnboardingPreAuthEvent("run-2", "cli_onboarding_auth_failed"),
    ).resolves.toBeUndefined();

    expect(mockDebug).toHaveBeenCalledWith(
      "setup",
      "CLI onboarding pre-auth analytics failed: cli_onboarding_auth_failed: Web app URL not configured",
    );
  });

  it("logs non-Error pre-auth tracking failures", async () => {
    mutate.mockRejectedValueOnce("anonymous network down");

    await expect(
      trackCliOnboardingPreAuthEvent("run-2", "cli_onboarding_auth_failed"),
    ).resolves.toBeUndefined();

    expect(mockDebug).toHaveBeenCalledWith(
      "setup",
      "CLI onboarding pre-auth analytics failed: cli_onboarding_auth_failed: anonymous network down",
    );
  });

  it("clears the tracking timeout after successful tracking", async () => {
    vi.useFakeTimers();
    const clearTimeoutSpy = vi.spyOn(globalThis, "clearTimeout");
    mutate.mockResolvedValueOnce(undefined);

    await trackCliOnboardingEvent(makeConfig(), "run-1", "cli_onboarding_started");

    expect(clearTimeoutSpy).toHaveBeenCalled();
    clearTimeoutSpy.mockRestore();
  });
});
