import { type AccountTarget, CONFIG_SCHEMA_VERSION, type Config, type SetupMode } from "./schema";

export interface FlatTestConfig {
  access_token: string;
  refresh_token: string;
  expires_at: number;
  user_id?: string;
  deployment_id?: string;
  deployment_name?: string;
  api_key?: string;
  org_id?: string;
  space_id?: string;
  mode?: SetupMode;
}

/** Keep test fixtures terse without exposing the retired flat schema to production code. */
export function makeTestConfig(flat: FlatTestConfig): Config {
  const target: AccountTarget = {
    deployment_id: flat.deployment_id,
    deployment_name: flat.deployment_name,
    api_key: flat.api_key,
    org_id: flat.org_id,
    space_id: flat.space_id,
  };

  return {
    schema_version: CONFIG_SCHEMA_VERSION,
    mode: flat.mode,
    active_account: {
      user_id: flat.user_id ?? "test-user-id",
      session: {
        access_token: flat.access_token,
        refresh_token: flat.refresh_token,
        expires_at: flat.expires_at,
      },
      target: Object.values(target).some((value) => value !== undefined) ? target : undefined,
    },
  };
}

export function testSession(cfg: Config) {
  const session = cfg.active_account?.session;
  if (!session) throw new Error("test config has no session");
  return session;
}

export function testTarget(cfg: Config) {
  const target = cfg.active_account?.target;
  if (!target) throw new Error("test config has no target");
  return target;
}

export function testAccessTokenFor(userID: string): string {
  const payload = Buffer.from(JSON.stringify({ sub: userID })).toString("base64url");
  return `test.${payload}.signature`;
}
