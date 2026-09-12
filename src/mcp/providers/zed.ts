import { homedir, platform } from "node:os";
import { join } from "node:path";
import { mcpBaseURL, mcpHeaders, mcpURL } from "../config-helpers";
import { appSupportDir } from "../detect";
import { createJSONProvider } from "./base";

/**
 * Zed keeps `settings.json` in its *config* dir, which is NOT the same as its
 * data dir (`~/Library/Application Support/Zed` on macOS — that one only holds
 * db/, extensions/, languages/, etc.). Per `crates/paths` in zed-industries/zed:
 *
 *   macOS   ~/.config/zed
 *   Linux   $XDG_CONFIG_HOME/zed  (fallback ~/.config/zed)
 *   Windows %APPDATA%\Zed
 *
 * Writing to the Application Support dir on macOS produced a file Zed never
 * reads, so `dosu setup` appeared to succeed while Zed showed no Dosu server.
 */
/* v8 ignore start -- platform dispatch: only one branch runs per CI runner */
function zedConfigDir(): string {
  const os = platform();
  if (os === "win32") return join(appSupportDir(), "Zed");
  if (os === "darwin") return join(homedir(), ".config", "zed");
  return join(appSupportDir(), "zed"); // Linux: appSupportDir() already honors XDG_CONFIG_HOME
}

/**
 * Zed's data dir (db/, extensions/, languages/); used only for install
 * detection so a Zed that has never written settings.json is still found.
 *
 *   macOS   ~/Library/Application Support/Zed
 *   Linux   $XDG_DATA_HOME/zed  (fallback ~/.local/share/zed)
 *   Windows %LOCALAPPDATA%\Zed
 */
function zedDataDir(): string {
  const os = platform();
  if (os === "darwin") return join(appSupportDir(), "Zed");
  if (os === "win32") return join(process.env.LOCALAPPDATA ?? "", "Zed");
  return join(process.env.XDG_DATA_HOME ?? join(homedir(), ".local", "share"), "zed");
}
/* v8 ignore stop */

/**
 * Zed's remote (HTTP) context-server entry is `{ url, headers? }` — there is
 * no `source`/`type` discriminator (see `ContextServerSettingsContent::Http`
 * in zed-industries/zed `crates/settings_content/src/project.rs`). The extra
 * keys the CLI used to emit are not part of Zed's settings schema.
 */
export const ZedProvider = () =>
  createJSONProvider({
    providerName: "Zed",
    providerID: "zed",
    local: true,
    priorityValue: 10,
    paths: [zedConfigDir(), zedDataDir()],
    globalPath: join(zedConfigDir(), "settings.json"),
    topKey: "context_servers",
    buildServer: (cfg) => ({
      // biome-ignore lint/style/noNonNullAssertion: guaranteed by install() guard
      url: mcpURL(cfg.active_account!.target!.deployment_id!),
      // biome-ignore lint/style/noNonNullAssertion: guaranteed by install() guard
      headers: mcpHeaders(cfg.active_account!.target!.api_key!),
    }),
    buildOSSServer: (cfg) => ({
      url: mcpBaseURL(),
      headers: mcpHeaders(cfg.active_account?.target?.api_key),
    }),
    localConfigPath: (cwd) => join(cwd, ".zed", "settings.json"),
  });
