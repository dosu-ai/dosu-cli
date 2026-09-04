/** URL getters: build-time defaults are inlined via `bun build --define`, so runtime repointing
 * needs the differently-named `*_OVERRIDE` env vars (the base names cannot be read at runtime). */

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

/** Base URL of the Dosu LLM gateway (the miner's ANTHROPIC_BASE_URL); the SDK binary appends
 * `/v1/messages`. */
export function getLlmGatewayURL(): string {
  return process.env.DOSU_LLM_GATEWAY_URL_OVERRIDE ?? `${getBackendURL()}/v1/llm-gateway`;
}
