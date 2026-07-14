import { join } from "node:path";
import { mcpHeaders, mcpURL } from "../config-helpers";
import { appSupportDir } from "../detect";
import { createJSONProvider } from "./base";

const extensionDir = () =>
  join(appSupportDir(), "Code", "User", "globalStorage", "saoudrizwan.claude-dev");

export const ClineProvider = () =>
  createJSONProvider({
    providerName: "Cline",
    providerID: "cline",
    local: false,
    priorityValue: 11,
    paths: [extensionDir()],
    globalPath: join(extensionDir(), "settings", "cline_mcp_settings.json"),
    topKey: "mcpServers",
    buildServer: (cfg) => ({
      // biome-ignore lint/style/noNonNullAssertion: guaranteed by install() guard
      url: mcpURL(cfg.active_account!.target!.deployment_id!),
      type: "streamableHttp",
      disabled: false,
      // biome-ignore lint/style/noNonNullAssertion: guaranteed by install() guard
      headers: mcpHeaders(cfg.active_account!.target!.api_key!),
    }),
  });
