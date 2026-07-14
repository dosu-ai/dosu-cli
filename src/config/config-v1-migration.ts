import { getAccessTokenUserID } from "./identity";
import { type AccountTarget, CONFIG_SCHEMA_VERSION, type Config, MODE_OSS } from "./schema";

/** Convert the pre-v2 flat config at the storage boundary. */
export function migrateLegacyConfig(value: unknown): Config {
  if (!isRecord(value)) return { schema_version: CONFIG_SCHEMA_VERSION };

  const accessToken = stringValue(value.access_token) ?? "";
  const refreshToken = stringValue(value.refresh_token) ?? "";
  const expiresAt = numberValue(value.expires_at) ?? 0;
  const hasSession = Boolean(accessToken || refreshToken || expiresAt);
  const userID = stringValue(value.user_id) ?? getAccessTokenUserID(accessToken);

  return {
    schema_version: CONFIG_SCHEMA_VERSION,
    mode: value.mode === MODE_OSS ? MODE_OSS : undefined,
    active_account: hasSession
      ? {
          user_id: userID,
          session: {
            access_token: accessToken,
            refresh_token: refreshToken,
            expires_at: expiresAt,
          },
          // An unowned legacy target is unsafe to carry into a future login.
          target: userID ? legacyTarget(value) : undefined,
        }
      : undefined,
  };
}

function legacyTarget(value: Record<string, unknown>): AccountTarget | undefined {
  const target: AccountTarget = {
    deployment_id: stringValue(value.deployment_id),
    deployment_name: stringValue(value.deployment_name),
    api_key: stringValue(value.api_key),
    org_id: stringValue(value.org_id),
    space_id: stringValue(value.space_id),
  };
  return Object.values(target).some((field) => field !== undefined) ? target : undefined;
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
