import { rmSync } from "node:fs";
import { homedir, platform } from "node:os";
import { join } from "node:path";
import { readJSONConfig, saveJSONConfig } from "../config-helpers";
import { appSupportDir } from "../detect";
import type { SetupProvider } from "../providers";
import { createJSONProvider } from "./base";

/**
 * Zed reads settings.json from its config dir, not its data dir:
 *   macOS   ~/.config/zed          Linux  $XDG_CONFIG_HOME/zed (~/.config/zed)
 *   Windows %APPDATA%\Zed
 */
/* v8 ignore start -- platform dispatch: only one branch runs per CI runner */
function zedConfigDir(): string {
  const os = platform();
  if (os === "win32") return join(appSupportDir(), "Zed");
  if (os === "darwin") return join(homedir(), ".config", "zed");
  return join(appSupportDir(), "zed"); // Linux: appSupportDir() already honors XDG_CONFIG_HOME
}

/**
 * Data dir (db/, extensions/), used only for install detection:
 *   macOS   ~/Library/Application Support/Zed   Linux  $XDG_DATA_HOME/zed (~/.local/share/zed)
 *   Windows %LOCALAPPDATA%\Zed
 */
function zedDataDir(): string {
  const os = platform();
  if (os === "darwin") return join(appSupportDir(), "Zed");
  if (os === "win32") return join(process.env.LOCALAPPDATA ?? "", "Zed");
  return join(process.env.XDG_DATA_HOME ?? join(homedir(), ".local", "share"), "zed");
}

/** Where CLI <= 0.52.2 wrote the entry on macOS (Zed's data dir, never read by Zed). */
function legacyDarwinSettingsPath(): string | null {
  return platform() === "darwin" ? join(appSupportDir(), "Zed", "settings.json") : null;
}
/* v8 ignore stop */

/**
 * Strips the stale dosu entry (and its API key) from a legacy settings file,
 * deleting the file outright when nothing else is left in it.
 */
export function removeLegacyDosuEntry(path: string): void {
  let cfg: ReturnType<typeof readJSONConfig>;
  try {
    cfg = readJSONConfig(path);
  } catch {
    return;
  }
  const servers = cfg.context_servers;
  if (typeof servers !== "object" || servers === null || !("dosu" in servers)) return;
  delete servers.dosu;
  const nothingElse = Object.keys(cfg).length === 1 && Object.keys(servers).length === 0;
  if (nothingElse) rmSync(path, { force: true });
  else saveJSONConfig(path, cfg);
}

// Zed's HTTP context_servers entry is `{ url, headers? }`; there is no
// `source`/`type` discriminator (ContextServerSettingsContent::Http).
export const ZedProvider = (legacyPath = legacyDarwinSettingsPath()): SetupProvider => {
  const provider = createJSONProvider({
    providerName: "Zed",
    providerID: "zed",
    local: true,
    priorityValue: 10,
    paths: [zedConfigDir(), zedDataDir()],
    globalPath: join(zedConfigDir(), "settings.json"),
    topKey: "context_servers",
    buildServer: ({ url, headers }) => ({ url, headers }),
    localConfigPath: (cwd) => join(cwd, ".zed", "settings.json"),
  });
  if (!legacyPath) return provider;
  return {
    ...provider,
    install(cfg, global) {
      provider.install(cfg, global);
      if (global) removeLegacyDosuEntry(legacyPath);
    },
    remove(global) {
      provider.remove(global);
      if (global) removeLegacyDosuEntry(legacyPath);
    },
  };
};
