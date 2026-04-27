/**
 * URL constants and environment-aware getters.
 *
 * Build-time defaults are baked into the bundle via `bun build --define`
 * (see `scripts/build-all.ts:buildDefines`). For each URL we also accept a
 * `*_OVERRIDE` env var that is read **at runtime** so internal/alpha builds
 * can be repointed at staging or local backends without rebuilding:
 *
 *   DOSU_WEB_APP_URL_OVERRIDE=https://staging.dosu.dev \
 *   DOSU_BACKEND_URL_OVERRIDE=https://api-staging.dosu.dev \
 *   SUPABASE_URL_OVERRIDE=... \
 *   SUPABASE_ANON_KEY_OVERRIDE=... \
 *   npx @dosu/cli@alpha setup
 *
 * The override names intentionally differ from the build-time names —
 * `process.env.DOSU_WEB_APP_URL` is replaced with a string literal at build
 * time so reading it at runtime is impossible.
 */

export function getWebAppURL(): string {
  return process.env.DOSU_WEB_APP_URL_OVERRIDE ?? process.env.DOSU_WEB_APP_URL ?? "";
}

export function getBackendURL(): string {
  return process.env.DOSU_BACKEND_URL_OVERRIDE ?? process.env.DOSU_BACKEND_URL ?? "";
}

export function getSupabaseURL(): string {
  return process.env.SUPABASE_URL_OVERRIDE ?? process.env.SUPABASE_URL ?? "";
}

export function getSupabaseAnonKey(): string {
  return process.env.SUPABASE_ANON_KEY_OVERRIDE ?? process.env.SUPABASE_ANON_KEY ?? "";
}
