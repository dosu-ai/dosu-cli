/**
 * URL constants and environment-aware getters.
 *
 * Values are loaded from .env files (.env.production / .env.development).
 * See .env.example for the full list of supported variables.
 */

export function isDev(): boolean {
  return process.env.DOSU_DEV === "true";
}

export function getWebAppURL(): string {
  return process.env.DOSU_WEB_APP_URL ?? "";
}

export function getBackendURL(): string {
  return process.env.DOSU_BACKEND_URL ?? "";
}

export function getSupabaseURL(): string {
  return process.env.SUPABASE_URL ?? "";
}

export function getSupabaseAnonKey(): string {
  return process.env.SUPABASE_ANON_KEY ?? "";
}
