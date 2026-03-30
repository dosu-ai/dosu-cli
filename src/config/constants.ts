/**
 * URL constants and environment-aware getters.
 *
 * Equivalent to Go's internal/config/constants.go
 */

const DevWebAppURL = "http://localhost:3001";
const ProdWebAppURL = "https://app.dosu.dev";

const DevBackendURL = "http://localhost:7001";
const ProdBackendURL = "https://api.dosu.dev";

const DevSupabaseURL = "http://localhost:54321";
const ProdSupabaseURL = "https://your-project.supabase.co";

function isDev(): boolean {
  return process.env.DOSU_DEV === "true";
}

export function getWebAppURL(): string {
  if (process.env.DOSU_WEB_APP_URL) return process.env.DOSU_WEB_APP_URL;
  return isDev() ? DevWebAppURL : ProdWebAppURL;
}

export function getBackendURL(): string {
  if (process.env.DOSU_BACKEND_URL) return process.env.DOSU_BACKEND_URL;
  return isDev() ? DevBackendURL : ProdBackendURL;
}

export function getSupabaseURL(): string {
  if (process.env.SUPABASE_URL) return process.env.SUPABASE_URL;
  return isDev() ? DevSupabaseURL : ProdSupabaseURL;
}
