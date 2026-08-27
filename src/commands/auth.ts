import pc from "picocolors";
import type { Config } from "../config/config";
import { loadConfig } from "../config/config";

export function requireLoginConfig(): Config {
  const cfg = loadConfig();
  if (!cfg.active_account?.session.access_token) {
    console.error(pc.red("Not logged in. Run 'dosu login' first."));
    process.exit(1);
  }
  return cfg;
}

export function requireOrgConfig(): { cfg: Config; orgId: string } {
  const cfg = requireLoginConfig();
  const orgId = cfg.active_account?.target?.org_id;
  if (!orgId) {
    console.error(pc.red("Missing org config. Run 'dosu setup' to reconfigure."));
    process.exit(1);
  }
  return { cfg, orgId };
}

export function requireAPIKey(cfg: Config): string {
  if (!cfg.active_account?.target?.api_key) {
    console.error(pc.red("API key not configured. Run 'dosu setup' first."));
    process.exit(1);
  }
  return cfg.active_account?.target?.api_key;
}
