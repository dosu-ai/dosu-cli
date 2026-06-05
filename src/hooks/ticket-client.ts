/**
 * Knowledge-ticket API client.
 *
 * Talks to the deployment-scoped ticket endpoints via the shared authenticated
 * `Client` (token refresh + 401/403 retry). The base URL is resolved from
 * `getBackendURL()` / `*_OVERRIDE`, so integration tests and local dev point at
 * the fake API by exporting `DOSU_BACKEND_URL_OVERRIDE` — the code path is
 * identical against the real and fake backends.
 *
 * This module is lazy-imported only off the hook fast-path (i.e. only when a
 * create or a poll is actually required), per the latency mitigations.
 */

import { Client } from "../client/client";
import type { Config } from "../config/config";

const TICKETS_PATH = "/v1/tickets/knowledge";

export interface CreateTicketRequest {
  deployment_id: string;
  agent: string;
  session_id: string;
  turn_id?: string | null;
  prompt: string;
  cwd?: string | null;
  repo?: string | null;
  data_source_ids?: string[] | null;
}

export interface CreateTicketResponse {
  ticket_id: string;
  status: string;
  created_at: string;
  expires_at: string;
  poll_url?: string;
}

export interface TicketSource {
  source_id: string;
  title: string;
  url: string;
  source_type: string;
  data_source_id: string | null;
}

export interface TicketResult {
  context: string;
  sources: TicketSource[];
  attribution: string;
  /** Server found no prior knowledge — the CLI appends a save_topic nudge. */
  save_recommended?: boolean;
}

export type TicketStatus = "pending" | "ready" | "failed" | "expired";

export interface TicketStatusResponse {
  ticket_id: string;
  status: TicketStatus;
  created_at: string;
  expires_at: string;
  result: TicketResult | null;
  error: string | null;
}

const KNOWN_STATUSES = new Set<TicketStatus>(["pending", "ready", "failed", "expired"]);

/** A non-2xx HTTP response from the ticket API. `transient` errors should be retried. */
export class TicketHttpError extends Error {
  readonly status: number;
  constructor(status: number) {
    super(`ticket request failed with status ${status}`);
    this.name = "TicketHttpError";
    this.status = status;
  }
  /** 5xx and 429 are worth retrying on a later tick; other 4xx are definitive. */
  get transient(): boolean {
    return this.status >= 500 || this.status === 429;
  }
}

/**
 * Classify a thrown poll error. Definitive errors stop polling (mark failed);
 * transient errors (network failures, 5xx, 429) just skip the tick.
 */
export function isDefinitiveError(err: unknown): boolean {
  if (err instanceof TicketHttpError) return !err.transient;
  return false; // network / unknown → transient
}

/** Create a knowledge ticket (fire-and-forget enqueue on the backend; returns immediately). */
export async function requestCreateTicket(
  cfg: Config,
  req: CreateTicketRequest,
): Promise<CreateTicketResponse> {
  const client = new Client(cfg);
  const resp = await client.post(TICKETS_PATH, req);
  if (resp.status !== 202 && resp.status !== 200 && resp.status !== 201) {
    throw new TicketHttpError(resp.status);
  }
  return (await resp.json()) as CreateTicketResponse;
}

/** Poll a ticket. Unknown status values are coerced to `failed` (closed-set contract). */
export async function requestGetTicket(
  cfg: Config,
  ticketId: string,
): Promise<TicketStatusResponse> {
  const client = new Client(cfg);
  const resp = await client.get(`${TICKETS_PATH}/${encodeURIComponent(ticketId)}`);
  if (resp.status !== 200 && resp.status !== 202) {
    throw new TicketHttpError(resp.status);
  }
  const data = (await resp.json()) as TicketStatusResponse;
  if (!KNOWN_STATUSES.has(data.status)) {
    return { ...data, status: "failed", result: null };
  }
  return data;
}
