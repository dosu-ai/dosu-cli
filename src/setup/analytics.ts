import { createTRPCClient, httpLink } from "@trpc/client";
import superjson from "superjson";
import { CLI_CONTRACT_HASH } from "../client/contract";
import { createTypedClient } from "../client/trpc";
import type { Config } from "../config/config";
import { getWebAppURL } from "../config/constants";
import { logger } from "../debug/logger";
import type { CliApiClient } from "../generated/dosu-api-types";
import { VERSION } from "../version/version";

type CliOnboardingEvent =
  | "cli_onboarding_auth_completed"
  | "cli_onboarding_started"
  | "cli_onboarding_failed"
  | "cli_onboarding_cancelled"
  | "cli_onboarding_options_selected"
  | "cli_onboarding_mcp_configured"
  | "cli_onboarding_skill_installed"
  | "cli_onboarding_github_connected"
  | "cli_onboarding_docs_imported"
  | "cli_onboarding_activated"
  | "cli_onboarding_completed";

type CliOnboardingPreAuthEvent =
  | "cli_onboarding_launch_attempted"
  | "cli_onboarding_auth_cancelled"
  | "cli_onboarding_auth_started"
  | "cli_onboarding_auth_failed";

type CliOnboardingProperties = Record<
  string,
  string | number | boolean | null | undefined | string[]
>;

const TRACKING_TIMEOUT_MS = 1_500;

// Analytics calls are typed straight from the generated contract — only the
// `user` router subset is needed here.
type CliOnboardingAnalyticsClient = Pick<CliApiClient, "user">;

export async function trackCliOnboardingEvent(
  cfg: Config,
  onboardingRunID: string,
  event: CliOnboardingEvent,
  properties: CliOnboardingProperties = {},
): Promise<void> {
  if (!cfg.access_token) return;

  try {
    const trpc: CliOnboardingAnalyticsClient = createTypedClient(cfg);
    await withTimeout(
      trpc.user.trackCliOnboardingEvent.mutate({
        event,
        properties: {
          ...baseProperties(cfg),
          onboarding_run_id: onboardingRunID,
          ...properties,
        },
      }),
      TRACKING_TIMEOUT_MS,
    );
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    logger.debug("setup", `CLI onboarding analytics failed: ${event}: ${msg}`);
  }
}

export async function trackCliOnboardingPreAuthEvent(
  onboardingRunID: string,
  event: CliOnboardingPreAuthEvent,
  properties: CliOnboardingProperties = {},
): Promise<void> {
  try {
    const trpc = createAnonymousClient();
    await withTimeout(
      trpc.user.trackCliOnboardingPreAuthEvent.mutate({
        event,
        onboarding_run_id: onboardingRunID,
        properties: {
          ...baseProperties({ access_token: "", refresh_token: "", expires_at: 0 }),
          ...properties,
        },
      }),
      TRACKING_TIMEOUT_MS,
    );
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    logger.debug("setup", `CLI onboarding pre-auth analytics failed: ${event}: ${msg}`);
  }
}

function baseProperties(cfg: Config): CliOnboardingProperties {
  return {
    cli_version: VERSION,
    platform: process.platform,
    arch: process.arch,
    mode: cfg.mode ?? "cloud",
    org_id: cfg.org_id,
    deployment_id: cfg.deployment_id,
    space_id: cfg.space_id,
  };
}

function createAnonymousClient(): CliOnboardingAnalyticsClient {
  const webAppURL = getWebAppURL();
  if (!webAppURL) {
    throw new Error("Web app URL not configured");
  }
  return createTRPCClient<never>({
    links: [
      httpLink({
        url: `${webAppURL}/api/cli-trpc`,
        transformer: superjson,
        headers: {
          "x-dosu-cli-contract": CLI_CONTRACT_HASH,
        },
      }),
    ],
  }) as unknown as CliOnboardingAnalyticsClient;
}

async function withTimeout<T>(promise: Promise<T>, timeoutMs: number): Promise<T> {
  let timeout: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        timeout = setTimeout(() => reject(new Error("tracking timeout")), timeoutMs);
      }),
    ]);
  } finally {
    if (timeout) clearTimeout(timeout);
  }
}
