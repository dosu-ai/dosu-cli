import { createTRPCClient, httpLink } from "@trpc/client";
import superjson from "superjson";
import { CLI_CONTRACT_HASH } from "../client/contract";
import { type Config, emptyConfig } from "../config/config";
import { getWebAppURL } from "../config/constants";
import { logger } from "../debug/logger";
import type { CliApiClient } from "../generated/dosu-api-types";
import { isTelemetryEnabled } from "../telemetry/settings";
import {
  fetchWithoutRedirect,
  parsePostHogProjectToken,
  parseTelemetryWebAppURL,
} from "../telemetry/telemetry";
import { INSTALL_CHANNEL, VERSION } from "../version/version";

type CliOnboardingEvent =
  | "cli_onboarding_auth_completed"
  | "cli_onboarding_started"
  | "cli_onboarding_failed"
  | "cli_onboarding_cancelled"
  | "cli_onboarding_mcp_configured"
  | "cli_onboarding_skill_installed"
  | "cli_onboarding_completed";

type CliOnboardingPreAuthEvent =
  | "cli_onboarding_launch_attempted"
  | "cli_onboarding_auth_cancelled"
  | "cli_onboarding_auth_started"
  | "cli_onboarding_auth_failed";

interface CliOnboardingProperties {
  has_deployment_option?: boolean;
  mode_option?: "cloud" | "oss";
  flow_kind?: "onboarding" | "oss" | "setup";
  reason?: string;
  provider_count?: number;
  providers?: string[];
  completed_mcp?: boolean;
  completed_skill?: boolean;
  completed_agents_md?: boolean;
  completed_logs_handoff?: boolean;
  logs_handoff?: "accepted" | "declined" | "cancelled";
}

interface OrganizationGroups {
  organization: string;
}

type SafePropertyValue = string | number | boolean | string[] | OrganizationGroups | undefined;
type SafeProperties = Record<string, SafePropertyValue>;

const SETUP_FAILURE_REASONS = new Set([
  "access_denied",
  "api_key_failed",
  "bad_oauth_state",
  "cloud_setup_context_failed",
  "deployment_resolution_failed",
  "invalid_request",
  "invalid_scope",
  "mcp_selection_cancelled",
  "oauth_callback_error",
  "onboarding_incomplete_after_handshake",
  "server_error",
  "temporarily_unavailable",
  "unauthorized_client",
  "unexpected_auth_error",
  "unsupported_response_type",
  "web_onboarding_incomplete",
]);

const TRACKING_TIMEOUT_MS = 500;

// Analytics calls are typed straight from the generated contract — only the
// `user` router subset is needed here.
type CliOnboardingAnalyticsClient = Pick<CliApiClient, "user">;

export async function trackCliOnboardingEvent(
  cfg: Config,
  onboardingRunID: string,
  event: CliOnboardingEvent,
  properties: CliOnboardingProperties = {},
): Promise<void> {
  try {
    if (!isTelemetryEnabled()) return;
    if (!analyticsReleaseEnabled()) return;
    if (!cfg.active_account?.session.access_token) return;
    if (!isUUID(onboardingRunID)) return;

    const input = {
      event,
      properties: {
        ...baseProperties(cfg),
        onboarding_run_id: onboardingRunID,
        ...allowlistedWorkflowProperties(properties),
      },
    };
    if (printDebugPayload(input)) return;
    await withTimeout(
      (signal) =>
        createAnalyticsClient(
          cfg.active_account?.session.access_token,
          signal,
        ).user.trackCliOnboardingEvent.mutate(input),
      TRACKING_TIMEOUT_MS,
    );
  } catch (err: unknown) {
    logTrackingFailure("analytics", event, err);
  }
}

export async function trackCliOnboardingPreAuthEvent(
  onboardingRunID: string,
  event: CliOnboardingPreAuthEvent,
  properties: CliOnboardingProperties = {},
): Promise<void> {
  try {
    if (!isTelemetryEnabled()) return;
    if (!analyticsReleaseEnabled()) return;
    if (!isUUID(onboardingRunID)) return;

    const input = {
      event,
      onboarding_run_id: onboardingRunID,
      properties: {
        ...baseProperties(emptyConfig()),
        ...allowlistedWorkflowProperties(properties),
      },
    };
    if (printDebugPayload(input)) return;
    await withTimeout(
      (signal) =>
        createAnalyticsClient(undefined, signal).user.trackCliOnboardingPreAuthEvent.mutate(input),
      TRACKING_TIMEOUT_MS,
    );
  } catch (err: unknown) {
    logTrackingFailure("pre-auth analytics", event, err);
  }
}

function logTrackingFailure(kind: string, event: string, error: unknown): void {
  try {
    const message = error instanceof Error ? error.message : String(error);
    logger.debug("setup", `CLI onboarding ${kind} failed: ${event}: ${message}`);
  } catch {
    // Telemetry diagnostics must never affect setup.
  }
}

function printDebugPayload(payload: unknown): boolean {
  if (process.env.DOSU_TELEMETRY_DEBUG !== "1") return false;
  console.error(`[dosu telemetry:posthog] ${JSON.stringify(payload)}`);
  return true;
}

function analyticsReleaseEnabled(): boolean {
  return Boolean(
    parsePostHogProjectToken(
      process.env.DOSU_POSTHOG_PROJECT_TOKEN_OVERRIDE ?? process.env.DOSU_POSTHOG_PROJECT_TOKEN,
    ),
  );
}

function baseProperties(cfg: Config): SafeProperties {
  const orgId = cfg.active_account?.target?.org_id;
  return {
    cli_version: safeIdentifier(VERSION, 32),
    install_channel: safeIdentifier(INSTALL_CHANNEL, 32),
    platform: safeIdentifier(process.platform, 24),
    arch: safeIdentifier(process.arch, 24),
    mode: cfg.mode ?? "cloud",
    ...(orgId && isUUID(orgId) ? { org_id: orgId, $groups: { organization: orgId } } : {}),
    deployment_id: safeIdentifier(cfg.active_account?.target?.deployment_id, 128),
    space_id: safeIdentifier(cfg.active_account?.target?.space_id, 128),
  };
}

function allowlistedWorkflowProperties(properties: CliOnboardingProperties): SafeProperties {
  const input = properties as unknown as Record<string, unknown>;
  const safe: SafeProperties = {};
  if (typeof input.has_deployment_option === "boolean") {
    safe.has_deployment_option = input.has_deployment_option;
  }
  if (input.mode_option === "cloud" || input.mode_option === "oss") {
    safe.mode_option = input.mode_option;
  }
  if (
    input.flow_kind === "onboarding" ||
    input.flow_kind === "oss" ||
    input.flow_kind === "setup"
  ) {
    safe.flow_kind = input.flow_kind;
  }
  if (typeof input.reason === "string" && SETUP_FAILURE_REASONS.has(input.reason)) {
    safe.reason = input.reason;
  }
  if (
    typeof input.provider_count === "number" &&
    Number.isInteger(input.provider_count) &&
    input.provider_count >= 0 &&
    input.provider_count <= 50
  ) {
    safe.provider_count = input.provider_count;
  }
  if (Array.isArray(input.providers)) {
    safe.providers = input.providers
      .filter(
        (provider): provider is string =>
          typeof provider === "string" && /^[a-z][a-z0-9-]{0,31}$/.test(provider),
      )
      .slice(0, 50);
  }
  for (const key of [
    "completed_mcp",
    "completed_skill",
    "completed_agents_md",
    "completed_logs_handoff",
  ] as const) {
    if (typeof input[key] === "boolean") safe[key] = input[key];
  }
  if (
    input.logs_handoff === "accepted" ||
    input.logs_handoff === "declined" ||
    input.logs_handoff === "cancelled"
  ) {
    safe.logs_handoff = input.logs_handoff;
  }
  return safe;
}

function safeIdentifier(value: unknown, maxLength: number): string | undefined {
  return typeof value === "string" &&
    value.length <= maxLength &&
    /^[A-Za-z0-9][A-Za-z0-9._+-]*$/.test(value)
    ? value
    : undefined;
}

function isUUID(value: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);
}

function createAnalyticsClient(
  accessToken?: string,
  requestSignal?: AbortSignal,
): CliOnboardingAnalyticsClient {
  const webAppURL = parseTelemetryWebAppURL(getWebAppURL(), process.env.DOSU_DEV === "true");
  if (!webAppURL) {
    throw new Error("Secure web app URL not configured");
  }
  return createTRPCClient<never>({
    links: [
      httpLink({
        url: `${webAppURL}/api/cli-trpc`,
        transformer: superjson,
        headers: {
          "x-dosu-cli-contract": CLI_CONTRACT_HASH,
          ...(accessToken ? { "Supabase-Access-Token": accessToken } : {}),
        },
        fetch: (url, options) => {
          const target =
            typeof url === "string" ? url : url instanceof URL ? url.toString() : url.url;
          return fetchWithoutRedirect(target, {
            ...options,
            redirect: "error",
            ...(requestSignal ? { signal: requestSignal } : {}),
          });
        },
      }),
    ],
  }) as unknown as CliOnboardingAnalyticsClient;
}

async function withTimeout<T>(
  operation: (signal: AbortSignal) => Promise<T>,
  timeoutMs: number,
): Promise<T> {
  const controller = new AbortController();
  let timeout: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      operation(controller.signal),
      new Promise<never>((_, reject) => {
        timeout = setTimeout(() => {
          controller.abort();
          reject(new Error("tracking timeout"));
        }, timeoutMs);
      }),
    ]);
  } finally {
    if (timeout) clearTimeout(timeout);
  }
}
