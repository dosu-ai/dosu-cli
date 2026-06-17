import { join } from "node:path";
import { createJSONProvider } from "./base";

export const FactoryProvider = () =>
  createJSONProvider({
    providerName: "Factory",
    providerID: "factory",
    local: true,
    priorityValue: 17,
    paths: ["~/.factory"],
    globalPath: "~/.factory/mcp.json",
    topKey: "mcpServers",
    localConfigPath: (cwd) => join(cwd, ".factory", "mcp.json"),
  });
