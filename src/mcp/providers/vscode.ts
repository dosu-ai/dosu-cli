import { join } from "node:path";
import { appSupportDir } from "../detect";
import { stdioServer } from "../proxy-entry";
import { createJSONProvider } from "./base";

export const VSCodeProvider = () =>
  createJSONProvider({
    providerName: "VS Code",
    providerID: "vscode",
    local: true,
    priorityValue: 6,
    paths: [join(appSupportDir(), "Code")],
    globalPath: join(appSupportDir(), "Code", "User", "mcp.json"),
    topKey: "servers",
    buildStdioServer: (proxy) => ({ type: "stdio", ...stdioServer(proxy) }),
    localConfigPath: (cwd) => join(cwd, ".vscode", "mcp.json"),
  });
