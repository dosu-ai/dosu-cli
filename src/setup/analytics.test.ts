import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CLI_CONTRACT_HASH } from "../client/contract";
import type { Config } from "../config/config";
import { type FlatTestConfig, makeTestConfig } from "../config/config.test-utils";

const { mockCreateTRPCClient, mockDebug, mockGetWebAppURL, mockHttpLink, mockTelemetryEnabled } =
  vi.hoisted(() => ({
    mockCreateTRPCClient: vi.fn(),
    mockDebug: vi.fn(),
    mockGetWebAppURL: vi.fn(),
    mockHttpLink: vi.fn((opts: unknown) => ({ type: "httpLink", opts })),
    mockTelemetryEnabled: vi.fn(),
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

vi.mock("../telemetry/settings", () => ({
  isTelemetryEnabled: mockTelemetryEnabled,
}));

import { trackCliOnboardingEvent, trackCliOnboardingPreAuthEvent } from "./analytics";

const mutate = vi.fn();
const RUN_ID = "11111111-1111-4111-8111-111111111111";
const OTHER_RUN_ID = "22222222-2222-4222-8222-222222222222";
let originalPostHogOverride: string | undefined;

function makeConfig(overrides: Partial<FlatTestConfig> = {}): Config {
  return makeTestConfig({
    access_token: "token",
    refresh_token: "refresh",
    expires_at: 0,
    org_id: "org-1",
    deployment_id: "dep-1",
    space_id: "space-1",
    ...overrides,
  });
}

function mockTrackingClient() {
  const client = {
    user: {
      trackCliOnboardingEvent: { mutate },
      trackCliOnboardingPreAuthEvent: { mutate },
    },
  };
  mockCreateTRPCClient.mockReturnValue(client);
  return client;
}

describe("setup analytics", () => {
  beforeEach(() => {
    originalPostHogOverride = process.env.DOSU_POSTHOG_PROJECT_TOKEN_OVERRIDE;
    process.env.DOSU_POSTHOG_PROJECT_TOKEN_OVERRIDE = "phc_test_public";
    vi.useRealTimers();
    mutate.mockReset().mockResolvedValue(undefined);
    mockCreateTRPCClient.mockReset();
    mockDebug.mockReset();
    mockGetWebAppURL.mockReset().mockReturnValue("https://app.test.dev");
    mockHttpLink.mockClear();
    mockTelemetryEnabled.mockReset().mockReturnValue(true);
    mockTrackingClient();
  });

  afterEach(() => {
    if (originalPostHogOverride === undefined) {
      delete process.env.DOSU_POSTHOG_PROJECT_TOKEN_OVERRIDE;
    } else {
      process.env.DOSU_POSTHOG_PROJECT_TOKEN_OVERRIDE = originalPostHogOverride;
    }
  });

  it("does not initialize a client when telemetry is disabled", async () => {
    mockTelemetryEnabled.mockReturnValue(false);

    await trackCliOnboardingEvent(makeConfig(), RUN_ID, "cli_onboarding_started");
    await trackCliOnboardingPreAuthEvent(OTHER_RUN_ID, "cli_onboarding_auth_started");

    expect(mockCreateTRPCClient).not.toHaveBeenCalled();
    expect(mutate).not.toHaveBeenCalled();
  });

  it("swallows telemetry settings failures before setup tracking starts", async () => {
    mockTelemetryEnabled.mockImplementation(() => {
      throw new Error("telemetry settings failed");
    });

    await expect(
      trackCliOnboardingEvent(makeConfig(), RUN_ID, "cli_onboarding_started"),
    ).resolves.toBeUndefined();
    await expect(
      trackCliOnboardingPreAuthEvent(OTHER_RUN_ID, "cli_onboarding_auth_started"),
    ).resolves.toBeUndefined();

    expect(mockCreateTRPCClient).not.toHaveBeenCalled();
    expect(mutate).not.toHaveBeenCalled();
  });

  it("keeps both setup analytics paths inert without the shared release token", async () => {
    delete process.env.DOSU_POSTHOG_PROJECT_TOKEN_OVERRIDE;
    delete process.env.DOSU_POSTHOG_PROJECT_TOKEN;

    await trackCliOnboardingEvent(makeConfig(), RUN_ID, "cli_onboarding_started");
    await trackCliOnboardingPreAuthEvent(OTHER_RUN_ID, "cli_onboarding_auth_started");

    expect(mockCreateTRPCClient).not.toHaveBeenCalled();
    expect(mutate).not.toHaveBeenCalled();
  });

  it("prints the exact outbound payload and sends nothing in telemetry debug mode", async () => {
    const original = process.env.DOSU_TELEMETRY_DEBUG;
    process.env.DOSU_TELEMETRY_DEBUG = "1";
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      await trackCliOnboardingEvent(makeConfig(), RUN_ID, "cli_onboarding_started", {
        flow_kind: "setup",
      });

      expect(mutate).not.toHaveBeenCalled();
      expect(errorSpy).toHaveBeenCalledOnce();
      expect(String(errorSpy.mock.calls[0]?.[0])).toContain('"event":"cli_onboarding_started"');
      expect(String(errorSpy.mock.calls[0]?.[0])).toContain('"flow_kind":"setup"');
    } finally {
      errorSpy.mockRestore();
      if (original === undefined) delete process.env.DOSU_TELEMETRY_DEBUG;
      else process.env.DOSU_TELEMETRY_DEBUG = original;
    }
  });

  it("skips authenticated tracking when access_token is missing", async () => {
    await trackCliOnboardingEvent(
      makeConfig({ access_token: "" }),
      RUN_ID,
      "cli_onboarding_started",
    );

    expect(mockCreateTRPCClient).not.toHaveBeenCalled();
    expect(mutate).not.toHaveBeenCalled();
  });

  it("tracks authenticated onboarding events with base and custom properties", async () => {
    await trackCliOnboardingEvent(makeConfig({ mode: "oss" }), RUN_ID, "cli_onboarding_completed", {
      completed_mcp: true,
    });

    expect(mockHttpLink).toHaveBeenCalledWith(
      expect.objectContaining({
        headers: {
          "Supabase-Access-Token": "token",
          "x-dosu-cli-contract": CLI_CONTRACT_HASH,
        },
        fetch: expect.any(Function),
      }),
    );
    expect(mutate).toHaveBeenCalledWith({
      event: "cli_onboarding_completed",
      properties: expect.objectContaining({
        onboarding_run_id: RUN_ID,
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
      trackCliOnboardingEvent(makeConfig(), RUN_ID, "cli_onboarding_failed"),
    ).resolves.toBeUndefined();

    expect(mockDebug).toHaveBeenCalledWith(
      "setup",
      "CLI onboarding analytics failed: cli_onboarding_failed: network down",
    );
  });

  it("logs Error instances from authenticated tracking failures", async () => {
    mutate.mockRejectedValueOnce(new Error("request failed"));

    await expect(
      trackCliOnboardingEvent(makeConfig(), RUN_ID, "cli_onboarding_failed"),
    ).resolves.toBeUndefined();

    expect(mockDebug).toHaveBeenCalledWith(
      "setup",
      "CLI onboarding analytics failed: cli_onboarding_failed: request failed",
    );
  });

  it("swallows failures from telemetry-only debug logging", async () => {
    mutate.mockRejectedValueOnce(new Error("request failed"));
    mockDebug.mockImplementationOnce(() => {
      throw new Error("debug logger failed");
    });

    await expect(
      trackCliOnboardingEvent(makeConfig(), RUN_ID, "cli_onboarding_failed"),
    ).resolves.toBeUndefined();
  });

  it("tracks pre-auth events through the anonymous client", async () => {
    await trackCliOnboardingPreAuthEvent(OTHER_RUN_ID, "cli_onboarding_auth_started", {
      has_deployment_option: false,
    });

    expect(mockHttpLink).toHaveBeenCalledWith(
      expect.objectContaining({
        url: "https://app.test.dev/api/cli-trpc",
        headers: { "x-dosu-cli-contract": CLI_CONTRACT_HASH },
      }),
    );
    expect(mockCreateTRPCClient).toHaveBeenCalledWith({
      links: [expect.objectContaining({ type: "httpLink" })],
    });
    expect(mutate).toHaveBeenCalledWith({
      event: "cli_onboarding_auth_started",
      onboarding_run_id: OTHER_RUN_ID,
      properties: expect.objectContaining({
        mode: "cloud",
        has_deployment_option: false,
      }),
    });
  });

  it("constructs setup properties from the allowlist instead of forwarding a property bag", async () => {
    await trackCliOnboardingEvent(makeConfig(), RUN_ID, "cli_onboarding_failed", {
      reason: "api_key_failed",
      raw_error: "token=secret in /Users/alice/project",
      providers: ["claude", "invalid provider /Users/alice"],
    } as never);

    const input = mutate.mock.calls[0]?.[0];
    expect(input.properties).toMatchObject({
      reason: "api_key_failed",
      providers: ["claude"],
    });
    expect(input.properties).not.toHaveProperty("raw_error");
    expect(JSON.stringify(input)).not.toContain("secret");
    expect(JSON.stringify(input)).not.toContain("/Users/alice");
  });

  it("logs and swallows pre-auth client setup failures", async () => {
    mockGetWebAppURL.mockReturnValueOnce("");

    await expect(
      trackCliOnboardingPreAuthEvent(OTHER_RUN_ID, "cli_onboarding_auth_failed"),
    ).resolves.toBeUndefined();

    expect(mockDebug).toHaveBeenCalledWith(
      "setup",
      "CLI onboarding pre-auth analytics failed: cli_onboarding_auth_failed: Secure web app URL not configured",
    );
  });

  it("never sends setup payloads or auth headers to a remote HTTP URL", async () => {
    const originalDosuDev = process.env.DOSU_DEV;
    process.env.DOSU_DEV = "true";
    mockGetWebAppURL.mockReturnValueOnce("http://remote.example.test");
    try {
      await trackCliOnboardingEvent(makeConfig(), RUN_ID, "cli_onboarding_started");

      expect(mockCreateTRPCClient).not.toHaveBeenCalled();
      expect(mutate).not.toHaveBeenCalled();
      expect(mockDebug).toHaveBeenCalledWith(
        "setup",
        "CLI onboarding analytics failed: cli_onboarding_started: Secure web app URL not configured",
      );
      expect(JSON.stringify(mockDebug.mock.calls)).not.toContain("remote.example.test");
    } finally {
      if (originalDosuDev === undefined) delete process.env.DOSU_DEV;
      else process.env.DOSU_DEV = originalDosuDev;
    }
  });

  it("logs non-Error pre-auth tracking failures", async () => {
    mutate.mockRejectedValueOnce("anonymous network down");

    await expect(
      trackCliOnboardingPreAuthEvent(OTHER_RUN_ID, "cli_onboarding_auth_failed"),
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

    await trackCliOnboardingEvent(makeConfig(), RUN_ID, "cli_onboarding_started");

    expect(clearTimeoutSpy).toHaveBeenCalled();
    clearTimeoutSpy.mockRestore();
  });

  it("aborts a hung setup analytics request after 500ms", async () => {
    vi.useFakeTimers();
    let observedSignal: AbortSignal | undefined;
    const fetchSpy = vi
      .spyOn(globalThis, "fetch")
      .mockImplementationOnce(
        async (_input: string | URL | Request, options?: RequestInit): Promise<Response> => {
          observedSignal = options?.signal ?? undefined;
          return await new Promise<Response>((_resolve, reject) => {
            observedSignal?.addEventListener("abort", () => reject(new Error("aborted")), {
              once: true,
            });
          });
        },
      );
    mutate.mockImplementationOnce(async (): Promise<void> => {
      const linkOptions = mockHttpLink.mock.calls.at(-1)?.[0] as {
        fetch: (url: string, options?: RequestInit) => Promise<Response>;
      };
      await linkOptions.fetch("https://app.test.dev/api/cli-trpc", { redirect: "follow" });
    });

    const tracking = trackCliOnboardingEvent(makeConfig(), RUN_ID, "cli_onboarding_started");
    await vi.advanceTimersByTimeAsync(500);

    await expect(tracking).resolves.toBeUndefined();
    expect(observedSignal?.aborted).toBe(true);
    expect(fetchSpy.mock.calls[0]?.[1]).toMatchObject({ redirect: "error" });
    fetchSpy.mockRestore();
  });
});
