import pc from "picocolors";
import type { Config } from "../config/config";
import { loadConfig } from "../config/config";

export function requireLoginConfig(): Config {
  const cfg = loadConfig();
  if (!cfg.access_token) {
    console.error(pc.red("Not logged in. Run 'dosu login' first."));
    process.exit(1);
  }
  return cfg;
}

export function requireAPIKey(cfg: Config): string {
  if (!cfg.api_key) {
    console.error(pc.red("API key not configured. Run 'dosu setup' first."));
    process.exit(1);
  }
  return cfg.api_key;
}
