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
 * holds a token from the server's `.env`. Several can be configured; `default_target` names the one
 * `dosu sync` uses without `--target`. */
export interface ServerTarget {
  /** Absent in config: a target with no `kind` is a server. */
  kind?: "server";
  /** How the target is named on the command line (`--target team`). */
  name: string;
  /** `https://host`, no trailing slash. */
  url: string;
  /** The name the server files sessions under (`owners/<owner>/`); dedupe is per owner. */
  owner: string;
  /** The bearer token (`sdb_…`). The config file is 0600. */
  token: string;
  /** The Dosu connection that reads this target's folder (its enrollment in the org's store, or
   * one made before buckets were the org's); absent when Dosu reads nothing through it. `dosu
   * sync` nudges it after shipping. */
  source_id?: string;
  /** Dosu's own sessiondb: the token came from the Dosu login (`POST /v1/memory/sources/hosted`)
   * rather than a server's `.env`, and is renewed from it before `token_expires_at`. */
  hosted?: boolean;
  /** Enrolled in the org's session store (`POST /v1/memory/store/enroll`): a minted token is
   * renewed by enrolling again rather than from `/sources/hosted`. */
  store?: boolean;
  /** When a hosted token stops working (ISO 8601). */
  token_expires_at?: string;
}

/** A bucket this machine writes itself, with no server: `@dosu/sessiondb` redacts and
 * normalizes each session here and writes it under `owners/<owner>/` with this machine's key.
 * The key should be scoped to that folder by the bucket's policy; the config file is 0600. */
export interface BucketTarget {
  kind: "bucket";
  name: string;
  /** `s3://bucket/prefix` or `r2://bucket/prefix`. */
  url: string;
  owner: string;
  /** AWS region (`s3://`). */
  region?: string;
  /** Cloudflare account id (`r2://`). */
  account_id?: string;
  /** S3-compatible endpoint (MinIO, Backblaze, an R2 endpoint given in full). */
  endpoint?: string;
  access_key_id: string;
  secret_access_key: string;
  session_token?: string;
  /** The Dosu source the bucket is connected as; absent when it is only an archive. */
  source_id?: string;
}

/** Where sessions ship: a sessiondb server, or a bucket written directly. */
export type SessionTarget = ServerTarget | BucketTarget;

/** Runtime and on-disk schema. Account-owned target state cannot exist outside its account. */
export interface Config {
  schema_version: typeof CONFIG_SCHEMA_VERSION;
  mode?: SetupMode;
  active_account?: ActiveAccount;
  /** Where sessions can ship: sessiondb servers and buckets. */
  targets?: SessionTarget[];
  /** The target `sync` ships to without `--target`. Unset: the only configured target. */
  default_target?: string;
}

export type AuthenticatedConfig = Config & { active_account: ActiveAccount };
