/** Ticket-poll login for headless environments: mints a ticket, prints the auth URL, and polls
 * until authorized or expired. Works where a localhost callback cannot receive the redirect. */

import type { TokenResponse } from "./server";
import { exchangeTicket, mintTicket } from "./ticket";

const POLL_INTERVAL_MS = 5_000;

export async function startDeviceFlow(signal?: AbortSignal): Promise<TokenResponse> {
  const minted = await mintTicket();

  console.log("\nCould not open a browser automatically.");
  console.log("Open this URL in your browser to log in:\n");
  console.log(`  ${minted.url}\n`);
  console.log("Waiting for authorization...");

  const deadline = Date.now() + minted.expires_in * 1000;

  while (Date.now() < deadline) {
    if (signal?.aborted) throw new Error("authentication cancelled");
    await sleep(POLL_INTERVAL_MS);
    if (signal?.aborted) throw new Error("authentication cancelled");

    const result = await exchangeTicket(minted.ticket);

    if (result.status === "authenticated") {
      return {
        access_token: result.access_token ?? "",
        refresh_token: result.refresh_token ?? "",
        expires_in: result.expires_in ?? 3600,
      };
    }

    if (result.status === "expired") {
      throw new Error("Login session expired. Run 'dosu login' to try again.");
    }

    // "pending" — keep polling
  }

  throw new Error("Authentication timed out. Run 'dosu login' to try again.");
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
