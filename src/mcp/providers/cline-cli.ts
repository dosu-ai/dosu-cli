import { join } from "node:path";
import { mcpHeaders, mcpURL } from "../config-helpers";
import { expandHome } from "../detect";
import { createJSONProvider } from "./base";

function clineDir(): string {
  return process.env.CLINE_DIR ?? expandHome("~/.cline");
}

export const ClineCliProvider = () =>
  createJSONProvider({
    providerName: "Cline CLI",
    providerID: "cline-cli",
    local: false,
    priorityValue: 12,
    paths: [clineDir()],
    globalPath: join(clineDir(), "data", "settings", "cline_mcp_settings.json"),
    topKey: "mcpServers",
    buildServer: (cfg) => ({
      url: mcpURL(cfg.deployment_id ?? ""),
      type: "streamableHttp",
      disabled: false,
      headers: mcpHeaders(cfg.api_key ?? ""),
    }),
  });
