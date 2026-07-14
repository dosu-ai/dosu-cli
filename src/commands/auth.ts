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

export function requireAPIKey(cfg: Config): string {
  if (!cfg.active_account?.target?.api_key) {
    console.error(pc.red("API key not configured. Run 'dosu setup' first."));
    process.exit(1);
  }
  return cfg.active_account?.target?.api_key;
}
