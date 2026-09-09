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

/** True for `http(s)://…` so the miner never gets a relative path like `/v1/llm-gateway`. */
export function isAbsoluteHttpUrl(value: string): boolean {
  try {
    const parsed = new URL(value);
    return parsed.protocol === "http:" || parsed.protocol === "https:";
  } catch {
    return false;
  }
}

/** Base URL of the Dosu LLM gateway (the miner's ANTHROPIC_BASE_URL); the SDK binary appends
 * `/v1/messages`. Empty when the backend URL is unset (uncompiled source without an env file),
 * which would otherwise become the relative `/v1/llm-gateway`. */
export function getLlmGatewayURL(): string {
  const override = process.env.DOSU_LLM_GATEWAY_URL_OVERRIDE;
  if (override) return override;
  const backend = getBackendURL().replace(/\/$/, "");
  return backend ? `${backend}/v1/llm-gateway` : "";
}
