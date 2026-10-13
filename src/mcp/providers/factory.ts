import { join } from "node:path";
import { stdioServer } from "../proxy-entry";
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
    buildStdioServer: (proxy) => ({ type: "stdio", ...stdioServer(proxy) }),
    localConfigPath: (cwd) => join(cwd, ".factory", "mcp.json"),
  });
