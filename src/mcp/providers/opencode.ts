import { join } from "node:path";
import { mcpHeaders, mcpURL } from "../config-helpers";
import { createJSONProvider } from "./base";

export const OpenCodeProvider = () =>
  createJSONProvider({
    providerName: "OpenCode",
    providerID: "opencode",
    configurationKind: "project",
    priorityValue: 14,
    paths: ["~/.config/opencode"],
    globalPath: "~/.config/opencode/opencode.json",
    topKey: "mcp",
    buildServer: (cfg) => ({
      type: "remote",
      // biome-ignore lint/style/noNonNullAssertion: guaranteed by install() guard
      url: mcpURL(cfg.active_account!.target!.deployment_id!),
      enabled: true,
      // biome-ignore lint/style/noNonNullAssertion: guaranteed by install() guard
      headers: mcpHeaders(cfg.active_account!.target!.api_key!),
    }),
    buildProjectServer: (command) => ({
      type: "local",
      command: [command.command, ...command.args],
      enabled: true,
    }),
    localConfigPath: (cwd) => join(cwd, "opencode.json"),
  });
