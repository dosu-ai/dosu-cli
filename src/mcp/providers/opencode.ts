import { join } from "node:path";
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
    buildStdioServer: ({ command, args, env }) => ({
      type: "local",
      command: [command, ...args],
      environment: env,
      enabled: true,
    }),
    buildServer: ({ url, headers }) => ({
      type: "remote",
      url,
      enabled: true,
      headers,
    }),
    localConfigPath: (cwd) => join(cwd, "opencode.json"),
  });
