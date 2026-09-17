/** Read the stable identity carried by a Supabase JWT; only correlates local state, never an
 * authorization decision (the backend validates every token). */
function getAccessTokenClaim(accessToken: string, claim: string): string | undefined {
  try {
    const payload = accessToken.split(".")[1];
    if (!payload) return undefined;
    const decoded = JSON.parse(Buffer.from(payload, "base64url").toString("utf8")) as Record<
      string,
      unknown
    >;
    const value = decoded[claim];
    return typeof value === "string" && value.length > 0 ? value : undefined;
  } catch {
    return undefined;
  }
}

export function getAccessTokenUserID(accessToken: string): string | undefined {
  return getAccessTokenClaim(accessToken, "sub");
}

export function getAccessTokenEmail(accessToken: string): string | undefined {
  return getAccessTokenClaim(accessToken, "email");
}

/** OAuth 2.1 access tokens carry the public client id needed for refresh. */
export function getAccessTokenOAuthClientID(accessToken: string): string | undefined {
  return getAccessTokenClaim(accessToken, "client_id");
}
