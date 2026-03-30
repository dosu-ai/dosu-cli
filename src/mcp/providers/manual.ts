import type { Config } from "../../config/config";
import { mcpURL } from "../config-helpers";
import type { Provider } from "../providers";

export const ManualProvider = (): Provider => ({
  name: () => "Manual Configuration",
  id: () => "manual",
  supportsLocal: () => false,

  install(cfg: Config): void {
    // biome-ignore lint/style/noNonNullAssertion: guaranteed by install() guard
    const url = mcpURL(cfg.deployment_id!);
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
