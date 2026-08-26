import { join } from "node:path";
import { createJSONProvider } from "./base";

export const FactoryProvider = () =>
  createJSONProvider({
    providerName: "Factory",
    providerID: "factory",
    configurationKind: "project",
    priorityValue: 17,
    paths: ["~/.factory"],
    globalPath: "~/.factory/mcp.json",
    topKey: "mcpServers",
    localConfigPath: (cwd) => join(cwd, ".factory", "mcp.json"),
  });
