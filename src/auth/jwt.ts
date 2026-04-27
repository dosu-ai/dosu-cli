/**
 * Minimal JWT helpers. The CLI receives Supabase access tokens whose payload
 * encodes the user id as the standard JWT `sub` claim; we occasionally need
 * that id (e.g. to pass to tRPC `user.updateProfile`) without round-tripping
 * to the server.
 *
 * No signature verification — the server always re-validates the token on
 * any call that actually uses it. This is purely a read-side helper.
 */

interface JwtPayload {
  sub?: string;
  email?: string;
  exp?: number;
  [key: string]: unknown;
}

/**
 * Decode the payload of a base64url-encoded JWT without verifying the
 * signature. Returns null on any parse failure (malformed token, missing
 * segments, invalid base64, invalid JSON).
 */
export function decodeJwtPayload(token: string): JwtPayload | null {
  if (!token) return null;
  const segments = token.split(".");
  if (segments.length < 2) return null;
  try {
    // base64url → base64: swap -/_ and pad to a multiple of 4.
    const b64url = segments[1];
    const b64 = b64url.replace(/-/g, "+").replace(/_/g, "/");
    const pad = b64.length % 4 === 0 ? "" : "=".repeat(4 - (b64.length % 4));
    const json = Buffer.from(b64 + pad, "base64").toString("utf-8");
    const parsed = JSON.parse(json);
    if (parsed && typeof parsed === "object") {
      return parsed as JwtPayload;
    }
    return null;
  } catch {
    return null;
  }
}

/**
 * Return the Supabase user id from an access token, or null if it can't be
 * extracted.
 */
export function userIdFromAccessToken(token: string): string | null {
  const payload = decodeJwtPayload(token);
  if (!payload || typeof payload.sub !== "string" || payload.sub.length === 0) {
    return null;
  }
  return payload.sub;
}
