/**
 * Read the stable identity carried by a Supabase JWT.
 *
 * This only correlates local state with an account. It is never an
 * authorization decision; the backend still validates every token.
 */
export function getAccessTokenUserID(accessToken: string): string | undefined {
  try {
    const payload = accessToken.split(".")[1];
    if (!payload) return undefined;
    const decoded = JSON.parse(Buffer.from(payload, "base64url").toString("utf8")) as {
      sub?: unknown;
    };
    return typeof decoded.sub === "string" && decoded.sub.length > 0 ? decoded.sub : undefined;
  } catch {
    return undefined;
  }
}
