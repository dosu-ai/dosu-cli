/**
 * Implementations for `dosu login --request` and `dosu login --check`.
 *
 * These are the low-level primitives that `dosu setup --agent` composes
 * internally. Exposing them on `login` mirrors Netlify CLI's
 * `login --request` / `login --check` flags so agents and scripts can
 * drive auth without touching the setup wizard.
 */

import { exchangeTicket, mintTicket } from "../auth/ticket";
import { loadConfig, replaceLoginSession, saveConfig } from "../config/config";
import { logger } from "../debug/logger";
import { emitError, emitJSONLine, emitStep } from "./output";

const CHECK_COMMAND_PREFIX = "dosu login --check";

export async function runLoginRequest(opts: { json: boolean }): Promise<number> {
  try {
    const minted = await mintTicket();
    const checkCommand = `${CHECK_COMMAND_PREFIX} ${minted.ticket}${opts.json ? " --json" : ""}`;

    if (opts.json) {
      emitJSONLine({
        ticket: minted.ticket,
        url: minted.url,
        check_command: checkCommand,
        expires_in: minted.expires_in,
        agent_next_steps:
          "Give the URL to the user so they can authorize. Once the user confirms they've signed in, run check_command to retrieve the token.",
      });
    } else {
      console.log("Open this URL in your browser to authorize:");
      console.log(`  ${minted.url}`);
      console.log("");
      console.log("After signing in, complete the login with:");
      console.log(`  ${checkCommand}`);
      console.log("");
      console.log(`Ticket expires in ${Math.floor(minted.expires_in / 60)} minutes.`);
    }
    return 0;
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    if (opts.json) {
      emitError({
        step: "request",
        reason: "mint_failed",
        agent_next_steps: `Could not mint a login ticket: ${msg}. Check connectivity and retry.`,
      });
    } else {
      console.error(`Failed to mint login ticket: ${msg}`);
    }
    return 1;
  }
}

export async function runLoginCheck(opts: { ticket: string; json: boolean }): Promise<number> {
  let result: Awaited<ReturnType<typeof exchangeTicket>>;
  try {
    result = await exchangeTicket(opts.ticket);
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    if (opts.json) {
      emitError({
        step: "check",
        reason: "exchange_failed",
        agent_next_steps: `Ticket exchange failed: ${msg}. Retry, or run 'dosu login --request' to get a fresh ticket.`,
      });
    } else {
      console.error(`Ticket exchange failed: ${msg}`);
    }
    return 1;
  }

  if (result.status === "authenticated") {
    const cfg = loadConfig();
    replaceLoginSession(cfg, {
      access_token: result.access_token ?? "",
      refresh_token: result.refresh_token ?? "",
      expires_at: Math.floor(Date.now() / 1000) + (result.expires_in ?? 3600),
    });
    saveConfig(cfg);
    logger.info("auth.ticket", "Ticket redeemed via dosu login --check");

    if (opts.json) {
      emitStep({
        step: "check",
        status: "authenticated",
        email: result.email,
        agent_next_steps:
          "Authentication complete. You can now run authenticated commands like 'dosu setup' or 'dosu status'.",
      });
    } else {
      console.log("Successfully authenticated!");
      if (result.email) console.log(`Signed in as ${result.email}`);
    }
    return 0;
  }

  if (result.status === "pending") {
    if (opts.json) {
      emitStep({
        step: "check",
        status: "pending",
        ticket: opts.ticket,
        agent_next_steps:
          "User hasn't completed sign-in yet. Ask the user to confirm they've signed in via the URL from --request, then run this check command again.",
      });
    } else {
      console.log("Still waiting for the user to complete sign-in. Run --check again later.");
    }
    return 0;
  }

  // expired
  if (opts.json) {
    emitStep({
      step: "check",
      status: "expired",
      agent_next_steps:
        "Ticket has expired or was already redeemed. Run 'dosu login --request --json' to get a fresh ticket.",
    });
  } else {
    console.error(
      "Ticket has expired or was already used. Run 'dosu login --request' for a new one.",
    );
  }
  return 1;
}
