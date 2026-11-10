/** Login-ticket primitives: unlike flow.ts this never holds an HTTP server open; a second CLI
 * invocation (`dosu login --check <ticket>`) exchanges the ticket after browser sign-in.
 *
 * Each ticket is bound to the CLI that minted it with PKCE (RFC 7636): minting sends the S256
 * challenge of a random verifier, and only that verifier can redeem the ticket. Minting and
 * redeeming often run in different processes, so the verifier is saved under the config dir
 * until the ticket is spent. */

import { createHash, randomBytes } from "node:crypto";
import { mkdirSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { getConfigDir } from "../config/config";
import { getBackendURL, getWebAppURL } from "../config/constants";
import { logger } from "../debug/logger";

export interface MintedTicket {
  ticket: string;
  expires_in: number;
  /** Fully-qualified URL the user opens in the browser to authorize. */
  url: string;
  /** Code the user types on that page to authorize; absent from backends that predate it. */
  user_code?: string;
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
  user_code?: string | null;
}

interface ExchangeTicketResponse {
  status: TicketStatus;
  access_token?: string | null;
  refresh_token?: string | null;
  expires_in?: number | null;
  email?: string | null;
}

interface SavedVerifier {
  code_verifier: string;
  expires_at: number;
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

  const verifier = randomBytes(32).toString("base64url");
  const resp = await fetchWithTimeout(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ code_challenge: s256(verifier), code_challenge_method: "S256" }),
  });
  if (resp.status !== 200 && resp.status !== 201) {
    const detail = await readErrorBody(resp);
    throw new Error(`failed to mint ticket (status ${resp.status}): ${detail}`);
  }

  const data = (await resp.json()) as MintTicketResponse;
  saveVerifier(data.ticket, verifier, data.expires_in);
  logger.info("auth.ticket", `Minted ticket (ttl=${data.expires_in}s)`);

  return {
    ticket: data.ticket,
    expires_in: data.expires_in,
    url: buildTicketAuthURL(data.ticket),
    user_code: data.user_code ?? undefined,
  };
}

/** Redeem a ticket for tokens: `authenticated` consumes it, `pending` means wait and retry,
 * `expired` means TTL elapsed, already redeemed, or not minted by this CLI (no saved verifier,
 * so the backend would refuse it). */
export async function exchangeTicket(ticket: string): Promise<ExchangedTicket> {
  const verifier = loadVerifier(ticket);
  if (verifier === undefined) {
    logger.info("auth.ticket", "No saved verifier for this ticket; treating it as expired");
    return { status: "expired" };
  }

  const path = `/v1/cli/auth/tickets/${encodeURIComponent(ticket)}/exchange`;
  const url = `${getBackendURL()}${path}`;
  logger.debug("auth.ticket", `Exchanging ticket via ${url}`);

  const resp = await fetchWithTimeout(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ code_verifier: verifier }),
  });
  if (resp.status !== 200) {
    // A 4xx is final (a rejected verifier deletes the ticket); after a 5xx a retry may still
    // redeem it, so the verifier stays.
    if (resp.status < 500) forgetVerifier(ticket);
    const detail = await readErrorBody(resp);
    throw new Error(`ticket exchange failed (status ${resp.status}): ${detail}`);
  }

  const data = (await resp.json()) as ExchangeTicketResponse;
  if (data.status !== "pending") forgetVerifier(ticket);
  return {
    status: data.status,
    access_token: data.access_token ?? undefined,
    refresh_token: data.refresh_token ?? undefined,
    expires_in: data.expires_in ?? undefined,
    email: data.email ?? undefined,
  };
}

/** RFC 7636 S256: unpadded base64url of the verifier's SHA-256. */
function s256(verifier: string): string {
  return createHash("sha256").update(verifier).digest("base64url");
}

function verifierDir(): string {
  return join(getConfigDir(), "login-tickets");
}

/** Named by the ticket's hash, so the file never holds a ticket next to the verifier that
 * redeems it. */
function verifierPath(ticket: string): string {
  return join(verifierDir(), `${createHash("sha256").update(ticket).digest("hex")}.json`);
}

function saveVerifier(ticket: string, verifier: string, expiresIn: number): void {
  const dir = verifierDir();
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  pruneExpiredVerifiers(dir);

  const saved: SavedVerifier = { code_verifier: verifier, expires_at: nowSeconds() + expiresIn };
  const path = verifierPath(ticket);
  // Write-then-rename so a concurrent prune never sees a half-written file.
  const tmp = `${path}.${process.pid}.tmp`;
  writeFileSync(tmp, JSON.stringify(saved), { mode: 0o600 });
  renameSync(tmp, path);
}

function loadVerifier(ticket: string): string | undefined {
  const verifier = readSaved(verifierPath(ticket))?.code_verifier;
  return typeof verifier === "string" ? verifier : undefined;
}

function forgetVerifier(ticket: string): void {
  rmSync(verifierPath(ticket), { force: true });
}

/** Drop the verifiers of logins that expired before anyone finished them. */
function pruneExpiredVerifiers(dir: string): void {
  const now = nowSeconds();
  for (const name of readdirSync(dir)) {
    if (!name.endsWith(".json")) continue;
    const expiresAt = readSaved(join(dir, name))?.expires_at;
    if (typeof expiresAt !== "number" || expiresAt <= now) {
      rmSync(join(dir, name), { force: true });
    }
  }
}

function readSaved(path: string): Partial<SavedVerifier> | undefined {
  try {
    const value: unknown = JSON.parse(readFileSync(path, "utf8"));
    return typeof value === "object" && value !== null ? value : undefined;
  } catch {
    return undefined;
  }
}

function nowSeconds(): number {
  return Math.floor(Date.now() / 1000);
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

/** The backend's `detail` message when the body has one, else the raw body. */
async function readErrorBody(resp: Response): Promise<string> {
  let body: string;
  try {
    body = await resp.text();
  } catch {
    return "";
  }
  let detail: unknown;
  try {
    detail = (JSON.parse(body) as { detail?: unknown }).detail;
  } catch {
    // not JSON
  }
  return (typeof detail === "string" ? detail : body).slice(0, 512);
}
