import { join } from "node:path";
import { createJSONProvider } from "./base";
import { mcpURL, mcpHeaders } from "../config-helpers";

export const OpenCodeProvider = () =>
  createJSONProvider({
    providerName: "OpenCode",
    providerID: "opencode",
    local: true,
    priorityValue: 14,
    paths: ["~/.config/opencode"],
    globalPath: "~/.config/opencode/opencode.json",
    topKey: "mcp",
    buildServer: (cfg) => ({
      type: "remote",
      url: mcpURL(cfg.deployment_id!),
      enabled: true,
      headers: mcpHeaders(cfg.api_key!),
    }),
    localConfigPath: (cwd) => join(cwd, "opencode.json"),
  });
