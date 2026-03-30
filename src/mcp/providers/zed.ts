import { platform } from "node:os";
import { join } from "node:path";
import { mcpHeaders, mcpURL } from "../config-helpers";
import { appSupportDir } from "../detect";
import { createJSONProvider } from "./base";

function zedConfigDir(): string {
  const os = platform();
  if (os === "darwin" || os === "win32") return join(appSupportDir(), "Zed");
  return join(appSupportDir(), "zed"); // Linux uses lowercase
}

export const ZedProvider = () =>
  createJSONProvider({
    providerName: "Zed",
    providerID: "zed",
    local: true,
    priorityValue: 10,
    paths: [zedConfigDir()],
    globalPath: join(zedConfigDir(), "settings.json"),
    topKey: "context_servers",
    buildServer: (cfg) => ({
      source: "custom",
      type: "http",
      url: mcpURL(cfg.deployment_id ?? ""),
      headers: mcpHeaders(cfg.api_key ?? ""),
    }),
    localConfigPath: (cwd) => join(cwd, ".zed", "settings.json"),
  });
