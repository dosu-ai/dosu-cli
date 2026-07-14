import { type Config, MODE_OSS } from "../../config/config";
import { mcpBaseURL, mcpHeaders, mcpURL } from "../config-helpers";
import type { Provider, ProviderInstallOptions } from "../providers";

function mcpEndpoint(cfg: Config): string {
  if (cfg.mode === MODE_OSS) return mcpBaseURL();
  if (!cfg.active_account?.target?.deployment_id) throw new Error("deployment ID is required");
  return mcpURL(cfg.active_account?.target?.deployment_id);
}

function maskSecret(secret: string): string {
  if (secret.length <= 8) return "[hidden]";
  const visibleChars = Math.min(4, Math.floor(secret.length / 4));
  return `${secret.slice(0, visibleChars)}...${secret.slice(-visibleChars)}`;
}

export const ManualProvider = (): Provider => ({
  name: () => "Manual Configuration",
  id: () => "manual",
  supportsLocal: () => false,

  install(cfg: Config, _global: boolean, opts: ProviderInstallOptions = {}): void {
    const url = mcpEndpoint(cfg);
    const apiKey = mcpHeaders(cfg.active_account?.target?.api_key)["X-Dosu-API-Key"];
    const headerValue = opts.showSecret ? apiKey : maskSecret(apiKey);
    console.log("Use these details to configure the Dosu MCP server in your client:");
    console.log();
    console.log(`  Transport:      HTTP`);
    console.log(`  Endpoint:       ${url}`);
    console.log(`  Header:         X-Dosu-API-Key: ${headerValue}`);
    if (!opts.showSecret) {
      console.log();
      console.log("  Secret hidden. Re-run with --show-secret to print the full API key.");
    }
    console.log();
  },

  remove(): void {
    console.log(
      "\nTo remove the Dosu MCP server, manually delete the configuration from your client.",
    );
  },
});
