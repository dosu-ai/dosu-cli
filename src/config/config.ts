/**
 * Config management — load/save JSON config from XDG config directory.
 */

import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";

/** Setup mode: OSS = public libraries only, undefined = standard (cloud) flow. */
export const MODE_OSS = "oss" as const;
export type SetupMode = typeof MODE_OSS;

export interface Config {
  access_token: string;
  refresh_token: string;
  expires_at: number;
  deployment_id?: string;
  deployment_name?: string;
  api_key?: string;
  mode?: SetupMode;
  org_id?: string;
  space_id?: string;
}

/**
 * The CLI uses separate config directories for dev and production so that
 * testing against a local dev stack never clobbers a user's real credentials.
 *
 * - Production: `~/.config/dosu-cli/` (or `$XDG_CONFIG_HOME/dosu-cli/`)
 * - Dev (`DOSU_DEV=true`): `~/.config/dosu-cli-dev/`
 *
 * Everything that lives under `getConfigDir()` — `config.json`,
 * `update-check.json`, `skill-update-check.json` — is isolated between the two.
 */
export function getConfigDir(): string {
  const dirName = process.env.DOSU_DEV === "true" ? "dosu-cli-dev" : "dosu-cli";

  const xdgConfig = process.env.XDG_CONFIG_HOME;
  if (xdgConfig) return join(xdgConfig, dirName);

  const home = process.env.HOME ?? process.env.USERPROFILE ?? "";
  return join(home, ".config", dirName);
}

export function getConfigPath(): string {
  const dir = getConfigDir();
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true, mode: 0o700 });
  }
  return join(dir, "config.json");
}

export function loadConfig(): Config {
  const path = getConfigPath();
  if (!existsSync(path)) {
    return emptyConfig();
  }
  try {
    const data = readFileSync(path, "utf-8");
    return JSON.parse(data) as Config;
  } catch {
    return emptyConfig();
  }
}

export function saveConfig(cfg: Config): void {
  const path = getConfigPath();
  const dir = getConfigDir();
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true, mode: 0o700 });
  }
  // Write-then-rename so concurrent CLI processes never observe a partially
  // written config and never interleave writes. A clobbered refresh token
  // would be replayed on the next refresh, and GoTrue's reuse detection can
  // revoke the whole session for a replayed token. The temp file lives in
  // the same directory (rename is only atomic within one filesystem) and is
  // pid-suffixed so sibling processes never share it.
  const tmp = `${path}.${process.pid}.tmp`;
  writeFileSync(tmp, JSON.stringify(cfg, null, 2), { mode: 0o600 });
  renameSync(tmp, path);
}

export function isAuthenticated(cfg: Config): boolean {
  return cfg.access_token !== "";
}

/**
 * Check if the token is expired or about to expire (within 5 minutes).
 */
export function isTokenExpired(cfg: Config): boolean {
  if (cfg.expires_at === 0) return false;
  return Math.floor(Date.now() / 1000) > cfg.expires_at - 300;
}

export function clearConfig(_cfg: Config): Config {
  return {
    access_token: "",
    refresh_token: "",
    expires_at: 0,
    deployment_id: undefined,
    deployment_name: undefined,
    api_key: undefined,
    mode: undefined,
    org_id: undefined,
    space_id: undefined,
  };
}

export function emptyConfig(): Config {
  return {
    access_token: "",
    refresh_token: "",
    expires_at: 0,
  };
}
