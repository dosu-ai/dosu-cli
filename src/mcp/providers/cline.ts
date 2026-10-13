import { join } from "node:path";
import { appSupportDir } from "../detect";
import { stdioServer } from "../proxy-entry";
import { createJSONProvider } from "./base";

const extensionDir = () =>
  join(appSupportDir(), "Code", "User", "globalStorage", "saoudrizwan.claude-dev");

export const ClineProvider = () =>
  createJSONProvider({
    providerName: "Cline",
    providerID: "cline",
    local: false,
    priorityValue: 11,
    paths: [extensionDir()],
    globalPath: join(extensionDir(), "settings", "cline_mcp_settings.json"),
    topKey: "mcpServers",
    buildStdioServer: (proxy) => ({ type: "stdio", ...stdioServer(proxy), disabled: false }),
    buildServer: ({ url, headers }) => ({
      url,
      type: "streamableHttp",
      disabled: false,
      headers,
    }),
  });
