/** Login-ticket primitives: unlike flow.ts this never holds an HTTP server open; a second CLI
 * invocation (`dosu login --check <ticket>`) exchanges the ticket after browser sign-in. */

import { getBackendURL, getWebAppURL } from "../config/constants";
import { logger } from "../debug/logger";

export interface MintedTicket {
  ticket: string;
  expires_in: number;
  /** Fully-qualified URL the user opens in the browser to authorize. */
  url: string;
}

type TicketStatus = "pending" | "authenticated" | "expired";

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

/** Build the browser URL that authorizes the ticket; the page binds the user's Supabase session
 * to it. */
export function buildTicketAuthURL(ticket: string): string {
  const base = getWebAppURL();
  const params = new URLSearchParams({ ticket });
  return `${base}/cli/auth?${params}`;
}

/** Mint a single-use, short-lived (10 minutes) login ticket that becomes useful once a
 * signed-in browser binds a Supabase session to it. */
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

/** Redeem a ticket for tokens: `authenticated` consumes it, `pending` means wait and retry,
 * `expired` means TTL elapsed or already redeemed. */
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
