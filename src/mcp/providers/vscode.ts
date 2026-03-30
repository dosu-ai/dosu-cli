import { join } from "node:path";
import { createJSONProvider } from "./base";
import { appSupportDir } from "../detect";

export const VSCodeProvider = () =>
  createJSONProvider({
    providerName: "VS Code",
    providerID: "vscode",
    local: true,
    priorityValue: 6,
    paths: [join(appSupportDir(), "Code")],
    globalPath: join(appSupportDir(), "Code", "User", "mcp.json"),
    topKey: "servers",
    localConfigPath: (cwd) => join(cwd, ".vscode", "mcp.json"),
  });
