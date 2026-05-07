/**
 * OAuth flow — browser-based authentication.
 */

import { getWebAppURL } from "../config/constants";
import { logger } from "../debug/logger";
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
  params: Record<string, string> = {},
): Promise<TokenResponse> {
  const { server, tokenPromise } = await startCallbackServer();

  let timeoutId: ReturnType<typeof setTimeout> | undefined;

  try {
    const callbackURL = `http://localhost:${server.port}/callback`;
    logger.debug("auth.flow", `Callback URL: ${callbackURL}`);
    const authURL = buildAuthURL(callbackURL, path, params);
    logger.info("auth.flow", `Auth URL: ${authURL}`);

    // Open browser — dynamic import to avoid bundling issues
    const open = await import("open");
    await open.default(authURL);
    logger.info("auth.flow", "Browser open command executed");

    // Race: token, abort, or timeout.
    //
    // 8 min is just under Supabase's default OAuth state TTL (~10 min). A
    // longer wait used to push users past that boundary — they'd come back
    // to a `bad_oauth_state` error in the browser while the CLI kept
    // spinning silently. Tightening the window means the worst case is
    // ~8 min of silence instead of 15, and the message points users at the
    // right next step.
    const timeout = new Promise<never>((_, reject) => {
      timeoutId = setTimeout(
        () => {
          logger.warn("auth.flow", "Authentication timed out (8min)");
          reject(
            new Error(
              "Authentication did not complete within 8 minutes. The OAuth state may have expired — please run `dosu login` again.",
            ),
          );
        },
        8 * 60 * 1000,
      );
    });

    const abort = signal
      ? new Promise<never>((_, reject) => {
          signal.addEventListener("abort", () => {
            logger.warn("auth.flow", "Authentication cancelled via abort");
            reject(new Error("authentication cancelled"));
          });
        })
      : new Promise<never>(() => {}); // never resolves

    const token = await Promise.race([tokenPromise, timeout, abort]);
    logger.info("auth.flow", "Token received");
    return token;
  } finally {
    clearTimeout(timeoutId);
    server.close();
    logger.debug("auth.flow", "Cleaning up: timeout cleared, server closed");
  }
}

function buildAuthURL(
  callbackURL: string,
  path: string,
  extraParams: Record<string, string>,
): string {
  const webAppURL = getWebAppURL();
  const params = new URLSearchParams({ callback: callbackURL, ...extraParams });
  return `${webAppURL}${path}?${params}`;
}
