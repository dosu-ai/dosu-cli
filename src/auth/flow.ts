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
export async function startOAuthFlow(signal?: AbortSignal): Promise<TokenResponse> {
  const { server, tokenPromise } = await startCallbackServer();

  try {
    const callbackURL = `http://localhost:${server.port}/callback`;
    const authURL = buildAuthURL(callbackURL);

    // Open browser — dynamic import to avoid bundling issues
    const open = await import("open");
    await open.default(authURL);

    // Race: token, abort, or timeout
    const timeout = new Promise<never>((_, reject) => {
      setTimeout(() => reject(new Error("authentication timeout - please try again")), 5 * 60 * 1000);
    });

    const abort = signal
      ? new Promise<never>((_, reject) => {
          signal.addEventListener("abort", () => reject(new Error("authentication cancelled")));
        })
      : new Promise<never>(() => {}); // never resolves

    return await Promise.race([tokenPromise, timeout, abort]);
  } finally {
    server.close();
  }
}

function buildAuthURL(callbackURL: string): string {
  const webAppURL = getWebAppURL();
  const params = new URLSearchParams({ callback: callbackURL });
  return `${webAppURL}/cli-login?${params}`;
}
