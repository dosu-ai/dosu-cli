import { type Config, MODE_OSS } from "../../config/config";
import { mcpBaseURL, mcpURL } from "../config-helpers";
import type { Provider } from "../providers";

function mcpEndpoint(cfg: Config): string {
  if (cfg.mode === MODE_OSS) return mcpBaseURL();
  if (!cfg.deployment_id) throw new Error("deployment ID is required");
  return mcpURL(cfg.deployment_id);
}

export const ManualProvider = (): Provider => ({
  name: () => "Manual Configuration",
  id: () => "manual",
  supportsLocal: () => false,

  install(cfg: Config): void {
    const url = mcpEndpoint(cfg);
    console.log("Use these details to configure the Dosu MCP server in your client:");
    console.log();
    console.log(`  Transport:      HTTP`);
    console.log(`  Endpoint:       ${url}`);
    console.log(`  Header:         X-Dosu-API-Key: ${cfg.api_key}`);
    console.log();
  },

  remove(): void {
    console.log(
      "\nTo remove the Dosu MCP server, manually delete the configuration from your client.",
    );
  },
});
