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
  space_id?: string;
}

export interface ActiveAccount {
  /** Missing only when a token does not expose a readable identity. */
  user_id?: string;
  session: Omit<SessionCredentials, "user_id">;
  target?: AccountTarget;
}

/** Runtime and on-disk schema. Account-owned target state cannot exist outside its account. */
export interface Config {
  schema_version: typeof CONFIG_SCHEMA_VERSION;
  mode?: SetupMode;
  active_account?: ActiveAccount;
}

export type AuthenticatedConfig = Config & { active_account: ActiveAccount };
