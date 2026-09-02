/**
 * OAuth flow — browser-based authentication.
 */

import { getWebAppURL } from "../config/constants";
import { logger } from "../debug/logger";
import { type SuccessVariant, startCallbackServer, type TokenResponse } from "./server";

export type OAuthFlowResult =
  | { browserOpened: true; token: TokenResponse }
  | { browserOpened: false };

/** Default wait for a plain auth roundtrip: under Supabase's ~10 min OAuth
 * state TTL, so we surface a useful message before users hit a stale-state
 * error. */
const DEFAULT_TIMEOUT_MS = 8 * 60 * 1000;

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
   * How long to wait for the callback. Defaults to 8 minutes (a plain auth
   * roundtrip). The setup handshake passes a much longer window: with
   * `intent=setup` the browser trip can contain the whole onboarding wizard
   * — including a GitHub App install that may sit on an org-admin approval.
   */
  timeoutMs?: number;
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
    successVariant: options.successVariant,
  });

  let timeoutId: ReturnType<typeof setTimeout> | undefined;

  try {
    const callbackURL = `http://localhost:${server.port}/callback`;
    logger.debug("auth.flow", `Callback URL: ${callbackURL}`);
    const authURL = buildAuthURL(callbackURL, path, params);
    logger.info("auth.flow", `Auth URL: ${authURL}`);
    options.onAuthURL?.(authURL);

    let browserOpened = false;
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

    if (!browserOpened && !options.waitWithoutBrowser) {
      logger.debug("auth.flow", "Browser unavailable, returning to caller for fallback");
      return { browserOpened: false };
      // Note: server.close() is called by the finally block below
    }

    const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    const timeoutMinutes = Math.round(timeoutMs / 60_000);
    const timeout = new Promise<never>((_, reject) => {
      timeoutId = setTimeout(() => {
        logger.warn("auth.flow", `Authentication timed out (${timeoutMinutes}min)`);
        reject(
          new Error(
            `Authentication did not complete within ${timeoutMinutes} minutes. ` +
              "If you finished in the browser after the timeout, just re-run the command.",
          ),
        );
      }, timeoutMs);
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
