/** Setup mode: OSS = public libraries only, undefined = standard (cloud) flow. */
export const MODE_OSS = "oss" as const;
export type SetupMode = typeof MODE_OSS;

export const CONFIG_SCHEMA_VERSION = 2 as const;

export interface SessionCredentials {
  access_token: string;
  refresh_token: string;
  expires_at: number;
  /** Stable account identity. Falls back to the access token's `sub` claim. */
  user_id?: string;
}

export interface AccountTarget {
  deployment_id?: string;
  deployment_name?: string;
  api_key?: string;
  org_id?: string;
  /** Display name of the organization the target lives in. */
  org_name?: string;
  space_id?: string;
  /** Display name of the Library (space) the MCP answers from. */
  library_name?: string;
}

interface ActiveAccount {
  /** Missing only when a token does not expose a readable identity. */
  user_id?: string;
  session: Omit<SessionCredentials, "user_id">;
  target?: AccountTarget;
}

/** A sessiondb server sessions ship to. The server holds the bucket and its keys; this machine
 * holds a token minted for one owner. Several can be configured; `default_target` names the one
 * `dosu sync` uses without `--target`. */
export interface ServerTarget {
  /** How the target is named on the command line (`--target team`). */
  name: string;
  /** `https://host`, no trailing slash. */
  url: string;
  /** The owner the token was minted for; the layout and dedupe are per owner. */
  owner: string;
  /** The bearer token (`sdb_…`). The config file is 0600. */
  token: string;
  /** The Dosu source the server's bucket is connected as (`dosu sources connect`); absent when
   * the bucket is only an archive. `dosu sync` nudges it after shipping. */
  source_id?: string;
}

/** Runtime and on-disk schema. Account-owned target state cannot exist outside its account. */
export interface Config {
  schema_version: typeof CONFIG_SCHEMA_VERSION;
  mode?: SetupMode;
  active_account?: ActiveAccount;
  /** The sessiondb servers sessions can ship to. */
  targets?: ServerTarget[];
  /** The target `sync` ships to without `--target`. Unset: the only configured target. */
  default_target?: string;
}

export type AuthenticatedConfig = Config & { active_account: ActiveAccount };
