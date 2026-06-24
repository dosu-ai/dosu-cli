/**
 * OAuth flow — browser-based authentication.
 */

import { getWebAppURL } from "../config/constants";
import { logger } from "../debug/logger";
import { startCallbackServer, type TokenResponse } from "./server";

export type OAuthFlowResult =
  | { browserOpened: true; token: TokenResponse }
  | { browserOpened: false };

/**
 * Starts the browser-based OAuth flow.
 * 1. Starts a local HTTP server on a random port
 * 2. Opens the browser to the Dosu web app login page
 * 3. Waits for the web app to redirect back with the token
 * 4. Returns { token, browserOpened: true } on success, or
 *    { browserOpened: false } immediately if the browser could not be opened
 *    (caller should fall through to the device/ticket flow).
 */
export async function startOAuthFlow(
  signal?: AbortSignal,
  path: string = "/cli/auth",
  params: Record<string, string> = {},
): Promise<OAuthFlowResult> {
  const { server, tokenPromise } = await startCallbackServer();

  let timeoutId: ReturnType<typeof setTimeout> | undefined;

  try {
    const callbackURL = `http://localhost:${server.port}/callback`;
    logger.debug("auth.flow", `Callback URL: ${callbackURL}`);
    const authURL = buildAuthURL(callbackURL, path, params);
    logger.info("auth.flow", `Auth URL: ${authURL}`);

    // Open browser — dynamic import to avoid bundling issues
    const open = await import("open");
    let browserOpened = false;
    try {
      await open.default(authURL);
      browserOpened = true;
      logger.info("auth.flow", "Browser open command executed");
    } catch (openErr) {
      logger.warn(
        "auth.flow",
        `Could not open browser automatically: ${openErr instanceof Error ? openErr.message : String(openErr)}`,
      );
    }

    if (!browserOpened) {
      logger.debug("auth.flow", "Browser unavailable — returning to caller for fallback");
      return { browserOpened: false };
      // Note: server.close() is called by the finally block below
    }

    // 8 min < Supabase's ~10 min OAuth state TTL, so we surface a useful
    // message before users hit a stale-state error.
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
    return { browserOpened: true, token };
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
