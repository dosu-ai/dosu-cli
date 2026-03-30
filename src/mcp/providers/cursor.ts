import { join } from "node:path";
import { createJSONProvider } from "./base";
import { mcpURL, mcpHeaders } from "../config-helpers";

export const CursorProvider = () =>
  createJSONProvider({
    providerName: "Cursor",
    providerID: "cursor",
    local: true,
    priorityValue: 5,
    paths: ["~/.cursor"],
    globalPath: "~/.cursor/mcp.json",
    topKey: "mcpServers",
    buildServer: (cfg) => ({
      url: mcpURL(cfg.deployment_id!),
      headers: mcpHeaders(cfg.api_key!),
    }),
    localConfigPath: (cwd) => join(cwd, ".cursor", "mcp.json"),
  });
