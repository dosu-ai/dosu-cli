import { CommandError } from "../cli/command-error";
import type { Config } from "../config/config";
import { loadConfig } from "../config/config";

// These throw instead of exiting so the failure unwinds through execute(), which prints it,
// records the command's telemetry failure event, and exits 1.

export function requireLoginConfig(): Config {
  const cfg = loadConfig();
  if (!cfg.active_account?.session.access_token) {
    throw new CommandError("NOT_LOGGED_IN", "Not logged in. Run 'dosu login' first.");
  }
  return cfg;
}

export function requireOrgConfig(): { cfg: Config; orgId: string } {
  const cfg = requireLoginConfig();
  const orgId = cfg.active_account?.target?.org_id;
  if (!orgId) {
    throw new CommandError(
      "NO_ORG_SELECTED",
      "Missing org config. Run 'dosu setup' to reconfigure.",
    );
  }
  return { cfg, orgId };
}

export function requireAPIKey(cfg: Config): string {
  const apiKey = cfg.active_account?.target?.api_key;
  if (!apiKey) {
    throw new CommandError("NO_API_KEY", "API key not configured. Run 'dosu setup' first.");
  }
  return apiKey;
}
