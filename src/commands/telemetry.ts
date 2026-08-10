import { Command } from "commander";
import { getWebAppURL } from "../config/constants";
import {
  getOrCreateInstallID,
  isTelemetryEnabled,
  loadTelemetrySettings,
  resetInstallID,
  setTelemetryEnabled,
  telemetryDisabledByEnvironment,
} from "../telemetry/settings";
import {
  parsePostHogProjectToken,
  parseSentryDsn,
  parseTelemetryWebAppURL,
} from "../telemetry/telemetry";

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
    enabled: isTelemetryEnabled(settings),
    destinations: {
      command_analytics: Boolean(commandWebAppURL && analyticsReleaseToken),
      setup_analytics: Boolean(setupWebAppURL && analyticsReleaseToken),
      error_diagnostics: Boolean(
        parseSentryDsn(process.env.DOSU_CLI_SENTRY_DSN_OVERRIDE ?? process.env.DOSU_CLI_SENTRY_DSN),
      ),
    },
    environment_override: environmentOverride ?? null,
    debug_mode: process.env.DOSU_TELEMETRY_DEBUG === "1",
    telemetry_id: settings.install_id ?? null,
  };
}

function printHumanStatus(): void {
  const status = statusPayload();
  console.log(`Telemetry: ${status.enabled ? "enabled" : "disabled"}`);
  console.log(
    `Destinations: command analytics PostHog ${status.destinations.command_analytics ? "configured" : "not configured"}, setup analytics Dosu API ${status.destinations.setup_analytics ? "configured" : "not configured"}, error diagnostics Sentry ${status.destinations.error_diagnostics ? "configured" : "not configured"}`,
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

function updateTelemetry(enabled: boolean): void {
  if (!setTelemetryEnabled(enabled)) {
    throw new Error("Could not save telemetry settings");
  }
  console.log(`Telemetry ${enabled ? "enabled" : "disabled"}.`);
}

export function telemetryCommand(): Command {
  const command = new Command("telemetry").description("Manage privacy-preserving telemetry");

  command
    .command("status")
    .description("Show telemetry state and destination configuration")
    .option("--json", "Output as JSON")
    .action((opts: { json?: boolean }) => {
      if (opts.json) {
        console.log(JSON.stringify(statusPayload(), null, 2));
        return;
      }
      printHumanStatus();
    });

  command
    .command("enable")
    .description("Enable telemetry")
    .action(() => updateTelemetry(true));

  command
    .command("disable")
    .description("Disable telemetry")
    .action(() => updateTelemetry(false));

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
