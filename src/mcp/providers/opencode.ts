import { join } from "node:path";
import { mcpHeaders, mcpURL } from "../config-helpers";
import { createJSONProvider } from "./base";

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
      // biome-ignore lint/style/noNonNullAssertion: guaranteed by install() guard
      url: mcpURL(cfg.deployment_id!),
      enabled: true,
      // biome-ignore lint/style/noNonNullAssertion: guaranteed by install() guard
      headers: mcpHeaders(cfg.api_key!),
    }),
    localConfigPath: (cwd) => join(cwd, "opencode.json"),
  });
