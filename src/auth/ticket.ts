/**
 * Login-ticket primitives for agent / human-in-the-loop authentication.
 *
 * Unlike the localhost-callback OAuth flow in `flow.ts`, this never holds an
 * HTTP server open. The CLI mints a ticket via the backend, prints the URL
 * the user should open, and exits. After the user signs in on the Dosu web
 * app, a second CLI invocation (`dosu login --check <ticket>`) exchanges the
 * ticket for tokens.
 *
 * Mirrors the shape of Netlify CLI's `login --request` / `--check`.
 */

import { getBackendURL, getWebAppURL } from "../config/constants";
import { logger } from "../debug/logger";

export interface MintedTicket {
  ticket: string;
  expires_in: number;
  /** Fully-qualified URL the user opens in the browser to authorize. */
  url: string;
}

export type TicketStatus = "pending" | "authenticated" | "expired";

export interface ExchangedTicket {
  status: TicketStatus;
  access_token?: string;
  refresh_token?: string;
  expires_in?: number;
  email?: string;
}

interface MintTicketResponse {
  ticket: string;
  expires_in: number;
}

interface ExchangeTicketResponse {
  status: TicketStatus;
  access_token?: string | null;
  refresh_token?: string | null;
  expires_in?: number | null;
  email?: string | null;
}

/**
 * Build the URL the user should open in their browser to authorize the
 * ticket. The page reads `?ticket=…`, asks the user to sign in if needed,
 * then binds their Supabase session to the ticket.
 */
export function buildTicketAuthURL(ticket: string): string {
  const base = getWebAppURL();
  const params = new URLSearchParams({ ticket });
  return `${base}/cli/auth?${params}`;
}

/**
 * Ask the Dosu backend for a fresh login ticket. The returned ticket is a
 * single-use, short-lived (10 minutes) handle that becomes useful once a
 * signed-in browser binds a Supabase session to it.
 */
export async function mintTicket(): Promise<MintedTicket> {
  const url = `${getBackendURL()}/v1/cli/auth/tickets`;
  logger.debug("auth.ticket", `Minting ticket via ${url}`);

  const resp = await fetchWithTimeout(url, { method: "POST" });
  if (resp.status !== 200 && resp.status !== 201) {
    const detail = await readErrorBody(resp);
    throw new Error(`failed to mint ticket (status ${resp.status}): ${detail}`);
  }

  const data = (await resp.json()) as MintTicketResponse;
  logger.info("auth.ticket", `Minted ticket (ttl=${data.expires_in}s)`);

  return {
    ticket: data.ticket,
    expires_in: data.expires_in,
    url: buildTicketAuthURL(data.ticket),
  };
}

/**
 * Attempt to redeem a ticket for tokens. Returns one of three statuses:
 *
 * - `authenticated`: tokens are returned and the ticket is consumed.
 * - `pending`: ticket exists but the user has not signed in yet — caller
 *   should wait and retry.
 * - `expired`: ticket not found (TTL elapsed or already redeemed).
 */
export async function exchangeTicket(ticket: string): Promise<ExchangedTicket> {
  const path = `/v1/cli/auth/tickets/${encodeURIComponent(ticket)}/exchange`;
  const url = `${getBackendURL()}${path}`;
  logger.debug("auth.ticket", `Exchanging ticket via ${url}`);

  const resp = await fetchWithTimeout(url, { method: "POST" });
  if (resp.status !== 200) {
    const detail = await readErrorBody(resp);
    throw new Error(`ticket exchange failed (status ${resp.status}): ${detail}`);
  }

  const data = (await resp.json()) as ExchangeTicketResponse;
  return {
    status: data.status,
    access_token: data.access_token ?? undefined,
    refresh_token: data.refresh_token ?? undefined,
    expires_in: data.expires_in ?? undefined,
    email: data.email ?? undefined,
  };
}

async function fetchWithTimeout(url: string, init: RequestInit): Promise<Response> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 10_000);
  try {
    return await fetch(url, { ...init, signal: controller.signal });
  } finally {
    clearTimeout(timeout);
  }
}

async function readErrorBody(resp: Response): Promise<string> {
  try {
    return (await resp.text()).slice(0, 512);
  } catch {
    return "";
  }
}
