/**
 * OAuth flow — browser-based authentication.
 */

import { getWebAppURL } from "../config/constants";
import { startCallbackServer, type TokenResponse } from "./server";

/**
 * Starts the browser-based OAuth flow.
 * 1. Starts a local HTTP server on a random port
 * 2. Opens the browser to the Dosu web app login page
 * 3. Waits for the web app to redirect back with the token
 * 4. Returns the token or throws
 */
export async function startOAuthFlow(
  signal?: AbortSignal,
  path: string = "/cli/auth",
): Promise<TokenResponse> {
  const { server, tokenPromise } = await startCallbackServer();

  let timeoutId: ReturnType<typeof setTimeout> | undefined;

  try {
    const callbackURL = `http://localhost:${server.port}/callback`;
    const authURL = buildAuthURL(callbackURL, path);

    // Open browser — dynamic import to avoid bundling issues
    const open = await import("open");
    await open.default(authURL);

    // Race: token, abort, or timeout
    const timeout = new Promise<never>((_, reject) => {
      timeoutId = setTimeout(
        () => reject(new Error("authentication timeout - please try again")),
        15 * 60 * 1000,
      );
    });

    const abort = signal
      ? new Promise<never>((_, reject) => {
          signal.addEventListener("abort", () => reject(new Error("authentication cancelled")));
        })
      : new Promise<never>(() => {}); // never resolves

    return await Promise.race([tokenPromise, timeout, abort]);
  } finally {
    clearTimeout(timeoutId);
    server.close();
  }
}

function buildAuthURL(callbackURL: string, path: string): string {
  const webAppURL = getWebAppURL();
  const params = new URLSearchParams({ callback: callbackURL });
  // For cli/setup, include redirect so OAuth callback returns to the same page
  // instead of defaulting to "/". The app's useOAuthRedirect hook reads this param.
  if (path !== "/cli/auth") {
    params.set("redirect", `${path}?callback=${encodeURIComponent(callbackURL)}`);
  }
  return `${webAppURL}${path}?${params}`;
}
