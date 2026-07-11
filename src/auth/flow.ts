/**
 * OAuth flow — browser-based authentication.
 */

import { getWebAppURL } from "../config/constants";
import { logger } from "../debug/logger";
import {
  type CallbackServer,
  type SuccessVariant,
  startCallbackServer,
  type TokenResponse,
} from "./server";

export type OAuthFlowResult =
  | { browserOpened: true; token: TokenResponse; server?: CallbackServer }
  | { browserOpened: false };

export interface OAuthFlowOptions {
  /** Called with the auth URL before the browser open is attempted. */
  onAuthURL?: (url: string) => void;
  /**
   * Keep waiting for the callback even if the browser could not be opened
   * (the user can open the URL from onAuthURL manually). Without this, a
   * failed browser open returns { browserOpened: false } immediately.
   */
  waitWithoutBrowser?: boolean;
  /**
   * Keep the callback server alive after the token arrives and return it on
   * the result, so the caller can steer the success page's tab onward via
   * `server.setNext(url)`. The caller owns closing the server.
   */
  holdNext?: boolean;
  /**
   * Don't open a browser — the caller navigates an already-open tab to the
   * auth URL itself (e.g. via a previous server's `setNext`). `onAuthURL`
   * still fires so the caller has the URL.
   */
  suppressBrowserOpen?: boolean;
  /** Success-page copy variant served on the callback. Defaults to "auth". */
  successVariant?: SuccessVariant;
}

/**
 * Starts the browser-based OAuth flow.
 * 1. Starts a local HTTP server on a random port
 * 2. Opens the browser to the Dosu web app login page
 * 3. Waits for the web app to redirect back with the token
 * 4. Returns { token, browserOpened: true } on success, or
 *    { browserOpened: false } immediately if the browser could not be opened
 *    (caller should fall through to the device/ticket flow).
 *
 * `onAuthURL` fires with the login URL once the browser opens, so callers can
 * show it as a manual fallback (e.g. the user closed the tab). It does NOT
 * fire when the browser fails to open — the callback server is torn down on
 * that path, so the URL would be a dead link; callers fall back to the
 * device/ticket flow instead.
 */
export async function startOAuthFlow(
  signal?: AbortSignal,
  path: string = "/cli/auth",
  params: Record<string, string> = {},
  onAuthURL?: (url: string) => void,
  options: OAuthFlowOptions = {},
): Promise<OAuthFlowResult> {
  const { server, tokenPromise } = await startCallbackServer({
    nextHold: options.holdNext,
    successVariant: options.successVariant,
  });

  let timeoutId: ReturnType<typeof setTimeout> | undefined;
  let handedOver = false;

  try {
    const callbackURL = `http://localhost:${server.port}/callback`;
    logger.debug("auth.flow", `Callback URL: ${callbackURL}`);
    const authURL = buildAuthURL(callbackURL, path, params);
    logger.info("auth.flow", `Auth URL: ${authURL}`);
    options.onAuthURL?.(authURL);

    let browserOpened = false;
    if (options.suppressBrowserOpen) {
      // The caller navigates an existing tab to authURL itself.
      browserOpened = true;
      logger.info("auth.flow", "Browser open suppressed — caller steers an existing tab");
    } else {
      // Open browser — dynamic import to avoid bundling issues
      const open = await import("open");
      try {
        await open.default(authURL);
        browserOpened = true;
        logger.info("auth.flow", "Browser open command executed");
        onAuthURL?.(authURL);
      } catch (openErr) {
        logger.warn(
          "auth.flow",
          `Could not open browser automatically: ${openErr instanceof Error ? openErr.message : String(openErr)}`,
        );
      }
    }

    if (!browserOpened && !options.waitWithoutBrowser) {
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
    if (options.holdNext) {
      // Caller takes over the server to steer the tab (and close it).
      handedOver = true;
      return { browserOpened: true, token, server };
    }
    return { browserOpened: true, token };
  } finally {
    clearTimeout(timeoutId);
    if (!handedOver) {
      server.close();
      logger.debug("auth.flow", "Cleaning up: timeout cleared, server closed");
    }
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
