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
    buildServer: ({ url, headers }) => ({
      type: "remote",
      url,
      enabled: true,
      headers,
    }),
    localConfigPath: (cwd) => join(cwd, "opencode.json"),
  });
