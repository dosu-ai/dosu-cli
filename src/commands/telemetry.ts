import { Command } from "commander";
import { getWebAppURL } from "../config/constants";
import {
  getOrCreateInstallID,
  isTelemetryEnabled,
  loadTelemetrySettings,
  resetInstallID,
  setTelemetryConsent,
  type TelemetryLane,
  telemetryDisabledByEnvironment,
} from "../telemetry/settings";
import {
  parsePostHogProjectToken,
  parseSentryDsn,
  parseTelemetryWebAppURL,
} from "../telemetry/telemetry";

type TelemetryTarget = TelemetryLane | "all";

function parseTarget(value: string | undefined): TelemetryTarget {
  const target = value ?? "all";
  if (target === "analytics" || target === "errors" || target === "all") return target;
  throw new Error("telemetry lane must be one of: analytics, errors, all");
}

function statusPayload() {
  const settings = loadTelemetrySettings();
  const environmentOverride = telemetryDisabledByEnvironment();
  const webAppURL = getWebAppURL();
  const commandWebAppURL = parseTelemetryWebAppURL(webAppURL);
  const setupWebAppURL = parseTelemetryWebAppURL(webAppURL, process.env.DOSU_DEV === "true");
  const analyticsReleaseToken = parsePostHogProjectToken(
    process.env.DOSU_POSTHOG_PROJECT_TOKEN_OVERRIDE ?? process.env.DOSU_POSTHOG_PROJECT_TOKEN,
  );
  return {
    schema_version: settings.schema_version,
    analytics: {
      decision:
        settings.analytics === undefined ? "unset" : settings.analytics ? "enabled" : "disabled",
      effective: isTelemetryEnabled("analytics"),
      command_destination_configured: Boolean(commandWebAppURL && analyticsReleaseToken),
      setup_destination_configured: Boolean(setupWebAppURL && analyticsReleaseToken),
    },
    errors: {
      decision: settings.errors === undefined ? "unset" : settings.errors ? "enabled" : "disabled",
      effective: isTelemetryEnabled("errors"),
      destination_configured: Boolean(
        parseSentryDsn(process.env.DOSU_SENTRY_DSN_OVERRIDE ?? process.env.DOSU_SENTRY_DSN),
      ),
    },
    environment_override: environmentOverride ?? null,
    debug_mode: process.env.DOSU_TELEMETRY_DEBUG === "1",
    telemetry_id: settings.install_id ?? null,
  };
}

function printHumanStatus(): void {
  const status = statusPayload();
  const effectiveSuffix = (effective: boolean) => (effective ? "on" : "off");
  console.log(
    `Usage analytics: ${status.analytics.decision} (effective ${effectiveSuffix(status.analytics.effective)})`,
  );
  console.log(
    `Error diagnostics: ${status.errors.decision} (effective ${effectiveSuffix(status.errors.effective)})`,
  );
  console.log(
    `Destinations: command analytics PostHog ${status.analytics.command_destination_configured ? "configured" : "not configured"}, setup analytics Dosu API ${status.analytics.setup_destination_configured ? "configured" : "not configured"}, error diagnostics Sentry ${status.errors.destination_configured ? "configured" : "not configured"}`,
  );
  if (status.environment_override) {
    console.log(`Environment override: ${status.environment_override}`);
  }
  if (status.debug_mode) console.log("Debug mode: on (payloads are printed to stderr, not sent)");
  if (status.telemetry_id) console.log(`Telemetry ID: ${status.telemetry_id}`);
  console.log(
    "Telemetry fields never include raw command lines, free-form arguments or option values, user source files, local paths, credentials, error messages, or debug.log; setup analytics uses only documented coarse fields and its existing Dosu session header only for API authorization.",
  );
}

function updateConsent(target: TelemetryTarget, enabled: boolean): void {
  if (!setTelemetryConsent(target, enabled)) {
    throw new Error("Could not save telemetry settings");
  }
  const verb = enabled ? "enabled" : "disabled";
  console.log(
    `Telemetry ${target === "all" ? "analytics and error diagnostics" : target} ${verb}.`,
  );
}

export function telemetryCommand(): Command {
  const command = new Command("telemetry").description(
    "Manage privacy-preserving usage analytics and error diagnostics",
  );

  command
    .command("status")
    .description("Show telemetry choices and effective configuration")
    .option("--json", "Output as JSON")
    .action((opts: { json?: boolean }) => {
      if (opts.json) {
        console.log(JSON.stringify(statusPayload(), null, 2));
        return;
      }
      printHumanStatus();
    });

  command
    .command("enable [lane]")
    .description("Enable analytics, errors, or all (default: all)")
    .action((lane?: string) => updateConsent(parseTarget(lane), true));

  command
    .command("disable [lane]")
    .description("Disable analytics, errors, or all (default: all)")
    .action((lane?: string) => updateConsent(parseTarget(lane), false));

  command
    .command("reset")
    .description("Rotate the local pseudonymous telemetry ID (does not delete prior events)")
    .action(() => {
      const previous = loadTelemetrySettings().install_id;
      const next = previous ? resetInstallID() : getOrCreateInstallID();
      if (!next) throw new Error("Could not save telemetry settings");
      console.log(`Telemetry ID ${previous ? "rotated" : "created"}: ${next}`);
      console.log("This does not delete events already retained by telemetry providers.");
    });

  return command;
}
