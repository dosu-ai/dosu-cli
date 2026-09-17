/** Config management: load/save JSON config from the XDG config directory. */

import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { migrateLegacyConfig } from "./config-v1-migration";
import { getAccessTokenUserID } from "./identity";
import {
  type AccountTarget,
  type AuthenticatedConfig,
  CONFIG_SCHEMA_VERSION,
  type Config,
  MODE_OSS,
  type SessionCredentials,
} from "./schema";

export {
  type AccountTarget,
  type AuthenticatedConfig,
  type Config,
  MODE_OSS,
  type SessionCredentials,
  type SetupMode,
} from "./schema";

export function getConfigUserID(cfg: Config): string | undefined {
  return (
    cfg.active_account?.user_id ??
    getAccessTokenUserID(cfg.active_account?.session.access_token ?? "")
  );
}

/** Replace credentials from an explicit login: same account preserves its target, a different
 * account replaces the whole aggregate so nothing survives the transition. */
export function replaceLoginSession(cfg: Config, session: SessionCredentials): void {
  const previousUserID = getConfigUserID(cfg);
  const nextUserID = session.user_id ?? getAccessTokenUserID(session.access_token);
  const preserveTarget = Boolean(previousUserID && nextUserID && previousUserID === nextUserID);

  cfg.active_account = {
    user_id: nextUserID,
    session: sessionWithoutIdentity(session),
    target: preserveTarget ? cloneTarget(cfg.active_account?.target) : undefined,
  };
}

/** Attach a backend-verified identity to the current session. */
export function bindAccountIdentity(cfg: Config, userID: string): void {
  const account = cfg.active_account;
  if (!account) throw new Error("cannot bind an identity without an authenticated session");
  if (account.user_id && account.user_id !== userID) account.target = undefined;
  account.user_id = userID;
}

export function updateTarget(cfg: Config, target: AccountTarget): void {
  if (!cfg.active_account?.user_id) {
    throw new Error("cannot bind a target without a verified account identity");
  }
  cfg.active_account.target = { ...cfg.active_account.target, ...target };
}

/** Separate config dirs for dev (`DOSU_DEV=true`, dosu-cli-dev) and production (dosu-cli) so
 * testing against a dev stack never clobbers real credentials. */
export function getConfigDir(): string {
  const dirName = process.env.DOSU_DEV === "true" ? "dosu-cli-dev" : "dosu-cli";

  const xdgConfig = process.env.XDG_CONFIG_HOME;
  if (xdgConfig) return join(xdgConfig, dirName);

  // homedir() resolves even without HOME in env; a "" fallback would make this a relative path
  // that strews .config/ dirs into random cwds.
  const home = process.env.HOME ?? process.env.USERPROFILE ?? homedir();
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
  if (!existsSync(path)) return emptyConfig();

  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(path, "utf-8")) as unknown;
  } catch {
    return emptyConfig();
  }

  const parsed = parseConfig(raw);
  if (isConfigV2(raw)) return parsed;
  // Legacy configs were unversioned. Never rewrite a schema this version does
  // not understand, or downgrading could destroy newer config data.
  if (isRecord(raw) && "schema_version" in raw) return parsed;

  try {
    writeConfig(path, parsed);
  } catch {
    // The parsed config is still usable even when its migration cannot be
    // persisted (for example, on a temporarily read-only filesystem).
  }
  return parsed;
}

/** Parse config content without performing filesystem writes. */
export function parseConfig(raw: unknown): Config {
  if (isConfigV2(raw)) return normalizeV2(raw);
  if (isRecord(raw) && "schema_version" in raw) return emptyConfig();
  return migrateLegacyConfig(raw);
}

export function saveConfig(cfg: Config): void {
  writeConfig(getConfigPath(), cfg);
}

export function isAuthenticated(cfg: Config): cfg is AuthenticatedConfig {
  return Boolean(cfg.active_account?.session.access_token);
}

/** Check if the token is expired or about to expire (within 5 minutes). */
export function isTokenExpired(cfg: Config): boolean {
  const expiresAt = cfg.active_account?.session.expires_at ?? 0;
  if (expiresAt === 0) return false;
  return Math.floor(Date.now() / 1000) > expiresAt - 300;
}

export function clearConfigInPlace(cfg: Config): void {
  cfg.mode = undefined;
  cfg.active_account = undefined;
}

export function emptyConfig(): Config {
  return { schema_version: CONFIG_SCHEMA_VERSION };
}

function sessionWithoutIdentity(session: SessionCredentials): Omit<SessionCredentials, "user_id"> {
  return {
    access_token: session.access_token,
    refresh_token: session.refresh_token,
    expires_at: session.expires_at,
  };
}

function cloneTarget(target: AccountTarget | undefined): AccountTarget | undefined {
  return target ? { ...target } : undefined;
}

function isConfigV2(value: unknown): value is Config {
  return isRecord(value) && value.schema_version === CONFIG_SCHEMA_VERSION;
}

function normalizeV2(value: Config): Config {
  const active = isRecord(value.active_account) ? value.active_account : undefined;
  const session = active && isRecord(active.session) ? active.session : undefined;
  if (!active || !session) {
    return {
      schema_version: CONFIG_SCHEMA_VERSION,
      mode: value.mode === MODE_OSS ? MODE_OSS : undefined,
    };
  }

  const accessToken = stringValue(session.access_token) ?? "";
  const userID = stringValue(active.user_id) ?? getAccessTokenUserID(accessToken);
  return {
    schema_version: CONFIG_SCHEMA_VERSION,
    mode: value.mode === MODE_OSS ? MODE_OSS : undefined,
    active_account: {
      user_id: userID,
      session: {
        access_token: accessToken,
        refresh_token: stringValue(session.refresh_token) ?? "",
        expires_at: numberValue(session.expires_at) ?? 0,
      },
      target: userID ? normalizeTarget(active.target) : undefined,
    },
  };
}

function normalizeTarget(value: unknown): AccountTarget | undefined {
  if (!isRecord(value)) return undefined;
  const target: AccountTarget = {
    deployment_id: stringValue(value.deployment_id),
    deployment_name: stringValue(value.deployment_name),
    api_key: stringValue(value.api_key),
    org_id: stringValue(value.org_id),
    org_name: stringValue(value.org_name),
    space_id: stringValue(value.space_id),
    library_name: stringValue(value.library_name),
  };
  return Object.values(target).some((field) => field !== undefined) ? target : undefined;
}

function writeConfig(path: string, config: Config): void {
  const dir = getConfigDir();
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true, mode: 0o700 });

  // Write-then-rename: a clobbered refresh token can revoke the whole session under GoTrue
  // reuse detection. Temp file is same-dir (rename atomicity) and pid-suffixed.
  const tmp = `${path}.${process.pid}.tmp`;
  writeFileSync(tmp, JSON.stringify(config, null, 2), { mode: 0o600 });
  renameSync(tmp, path);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function numberValue(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}
