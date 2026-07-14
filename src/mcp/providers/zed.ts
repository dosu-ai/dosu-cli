import { platform } from "node:os";
import { join } from "node:path";
import { mcpHeaders, mcpURL } from "../config-helpers";
import { appSupportDir } from "../detect";
import { createJSONProvider } from "./base";

/* v8 ignore start -- platform dispatch: only one branch runs per CI runner */
function zedConfigDir(): string {
  const os = platform();
  if (os === "darwin" || os === "win32") return join(appSupportDir(), "Zed");
  return join(appSupportDir(), "zed"); // Linux uses lowercase
}
/* v8 ignore stop */

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
      // biome-ignore lint/style/noNonNullAssertion: guaranteed by install() guard
      url: mcpURL(cfg.active_account!.target!.deployment_id!),
      // biome-ignore lint/style/noNonNullAssertion: guaranteed by install() guard
      headers: mcpHeaders(cfg.active_account!.target!.api_key!),
    }),
    localConfigPath: (cwd) => join(cwd, ".zed", "settings.json"),
  });
