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
      url: mcpURL(cfg.deployment_id ?? ""),
      type: "streamableHttp",
      disabled: false,
      headers: mcpHeaders(cfg.api_key ?? ""),
    }),
  });
