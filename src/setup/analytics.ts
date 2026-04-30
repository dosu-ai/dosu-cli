import { createTypedClient } from "../client/trpc";
import type { Config } from "../config/config";
import { logger } from "../debug/logger";
import { VERSION } from "../version/version";

export type CliOnboardingEvent =
  | "cli_onboarding_started"
  | "cli_onboarding_auth_completed"
  | "cli_onboarding_options_selected"
  | "cli_onboarding_mcp_configured"
  | "cli_onboarding_skill_installed"
  | "cli_onboarding_github_connected"
  | "cli_onboarding_docs_imported"
  | "cli_onboarding_completed"
  | "cli_onboarding_activated"
  | "cli_onboarding_cancelled"
  | "cli_onboarding_failed";

type CliOnboardingProperties = Record<
  string,
  string | number | boolean | null | undefined | string[]
>;

const TRACKING_TIMEOUT_MS = 1_500;

// `@dosu/api-types` can trail app routers; keep this best-effort tracking path narrow.
// biome-ignore lint/suspicious/noExplicitAny: see note above.
type TrpcAny = any;

export async function trackCliOnboardingEvent(
  cfg: Config,
  event: CliOnboardingEvent,
  properties: CliOnboardingProperties = {},
): Promise<void> {
  if (!cfg.access_token) return;

  try {
    const trpc = createTypedClient(cfg) as TrpcAny;
    await withTimeout(
      trpc.user.trackCliOnboardingEvent.mutate({
        event,
        properties: {
          ...baseProperties(cfg),
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
