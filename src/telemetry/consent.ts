import * as p from "@clack/prompts";
import {
  loadTelemetrySettings,
  setTelemetryConsents,
  telemetryDisabledByEnvironment,
} from "./settings";

type ConsentChoice = "analytics-and-errors" | "analytics-only" | "errors-only" | "neither";
type MissingConsentChoice = "enable" | "disable";

const CONSENTS_BY_CHOICE: Record<ConsentChoice, { analytics: boolean; errors: boolean }> = {
  "analytics-and-errors": { analytics: true, errors: true },
  "analytics-only": { analytics: true, errors: false },
  "errors-only": { analytics: false, errors: true },
  neither: { analytics: false, errors: false },
};

export async function promptForTelemetryConsent(): Promise<void> {
  if (telemetryDisabledByEnvironment()) return;
  const settings = loadTelemetrySettings();
  if (settings.analytics !== undefined && settings.errors !== undefined) return;

  if (settings.analytics !== undefined || settings.errors !== undefined) {
    const lane = settings.analytics === undefined ? "analytics" : "errors";
    const label = lane === "analytics" ? "usage analytics" : "error diagnostics";
    const choice = await p.select<MissingConsentChoice>({
      message:
        lane === "analytics"
          ? "Share usage analytics? General commands use a random installation ID; setup-funnel events can be linked to your Dosu account and email after sign-in and may include documented coarse setup choices, never raw command lines or free-form values. You can change this later."
          : "Share error diagnostics? Dosu sends allowlisted error codes and its own stack frames, never raw error messages or local paths. You can change this later.",
      options: [
        { label: `Don't share ${label}`, value: "disable" },
        { label: `Share ${label}`, value: "enable" },
      ],
      initialValue: "disable",
    });
    setTelemetryConsents({ [lane]: !p.isCancel(choice) && choice === "enable" });
    return;
  }

  const choice = await p.select<ConsentChoice>({
    message:
      "Help improve Dosu? Usage analytics uses a random installation ID; setup-funnel events " +
      "can be linked to your Dosu account and email after sign-in and may include documented coarse setup choices. " +
      "We never collect prompts, raw command lines, free-form argument or option values, your source code, " +
      "file contents, local paths, raw environment-variable names or values, credentials, raw error messages, or debug.log. " +
      "You can change these choices later.",
    options: [
      { label: "Don't share telemetry", value: "neither" },
      {
        label: "Share usage analytics and error diagnostics",
        value: "analytics-and-errors",
      },
      { label: "Share usage analytics only", value: "analytics-only" },
      { label: "Share error diagnostics only", value: "errors-only" },
    ],
    initialValue: "neither",
  });

  setTelemetryConsents(
    p.isCancel(choice) ? CONSENTS_BY_CHOICE.neither : CONSENTS_BY_CHOICE[choice],
  );
}
