import { join } from "node:path";
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
    buildServer: ({ url, headers }) => ({
      url,
      type: "streamableHttp",
      disabled: false,
      headers,
    }),
  });
