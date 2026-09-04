/** OAuth flow: browser-based authentication. */

import { getWebAppURL } from "../config/constants";
import { logger } from "../debug/logger";
import { type SuccessVariant, startCallbackServer, type TokenResponse } from "./server";

export type OAuthFlowResult =
  | { browserOpened: true; token: TokenResponse }
  | { browserOpened: false };

/** Kept under Supabase's ~10 min OAuth state TTL so users see a useful message before a
 * stale-state error. */
const DEFAULT_TIMEOUT_MS = 8 * 60 * 1000;

export interface OAuthFlowOptions {
  /** Called with the auth URL before the browser open is attempted. */
  onAuthURL?: (url: string) => void;
  /** Keep waiting for the callback even if the browser could not be opened; without this a
   * failed browser open returns { browserOpened: false } immediately. */
  waitWithoutBrowser?: boolean;
  /** Callback wait, default 8 minutes; setup passes a longer window since its browser trip can
   * contain the whole onboarding wizard. */
  timeoutMs?: number;
  /** Success-page copy variant served on the callback. Defaults to "auth". */
  successVariant?: SuccessVariant;
}

/** Starts the browser-based OAuth flow; returns { browserOpened: false } if the browser cannot
 * open (onAuthURL does not fire on that path; callers fall back to the device/ticket flow). */
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
