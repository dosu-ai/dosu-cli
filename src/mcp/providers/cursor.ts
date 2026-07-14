import { join } from "node:path";
import { mcpHeaders, mcpURL } from "../config-helpers";
import { createJSONProvider } from "./base";

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
      // biome-ignore lint/style/noNonNullAssertion: guaranteed by install() guard
      url: mcpURL(cfg.active_account!.target!.deployment_id!),
      // biome-ignore lint/style/noNonNullAssertion: guaranteed by install() guard
      headers: mcpHeaders(cfg.active_account!.target!.api_key!),
    }),
    localConfigPath: (cwd) => join(cwd, ".cursor", "mcp.json"),
  });
