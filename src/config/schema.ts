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

/** Static bucket credentials, when not taken from the environment. The config file is 0600. */
export interface BucketCredentials {
  access_key_id: string;
  secret_access_key: string;
  session_token?: string;
}

/** A place sessions ship to besides (or instead of) Dosu: an S3 / R2 bucket or a local folder,
 * written in the `@dosu/sessionstorage` layout. */
export interface BucketTarget {
  /** How the target is named on the command line (`--target team`). */
  name: string;
  /** `s3://bucket/prefix`, `r2://bucket/prefix` or `file:///path` (a bare path is a folder too). */
  url: string;
  /** The layout and dedupe are per owner; required. */
  owner: string;
  /** AWS region, for `s3://`. */
  region?: string;
  /** Cloudflare account id, for `r2://`. */
  account_id?: string;
  /** Explicit endpoint for S3-compatible stores (MinIO, RustFS); overrides region/account. */
  endpoint?: string;
  /** `"env"` (default): AWS / `R2_*` environment variables and profiles; else static keys. */
  credentials?: "env" | BucketCredentials;
  /** The Dosu source this bucket is connected as (`dosu sources connect`); absent when the
   * bucket is only an archive. `dosu sync` nudges it after shipping. */
  source_id?: string;
}

/** Runtime and on-disk schema. Account-owned target state cannot exist outside its account. */
export interface Config {
  schema_version: typeof CONFIG_SCHEMA_VERSION;
  mode?: SetupMode;
  active_account?: ActiveAccount;
  /** Bucket / folder targets; the Dosu target is the login, not listed here. */
  targets?: BucketTarget[];
  /** The target `sync` ships to without `--target`: a bucket target's name, or `dosu`. Unset:
   * the Dosu login when it can ship, else the first bucket target. */
  default_target?: string;
}

export type AuthenticatedConfig = Config & { active_account: ActiveAccount };
