/** Tokens Dosu mints for its own sessiondb, or for an org's server store whose token secret it
 * holds: a target enrolled in the org's store (`store.ts`) or set up before stores existed
 * (`POST /v1/memory/sources/hosted`, named `dosu`) ships with one. This machine tries a fresh
 * token against the server it is for before saving it, as a pasted one would be tried.
 *
 * The token expires. The backend renews it on the same call, so `dosu sync` asks again when
 * the expiry is near (`renewHostedToken`); a run that cannot reach Dosu ships with the token
 * it has. */

import { CliUsageError } from "../cli/errors";
import { type Config, saveConfig } from "../config/config";
import type { ServerTarget } from "../config/schema";
import { configuredTargets } from "../config/targets";
import { logger } from "../debug/logger";
import type { HostedSource, SourcesApi } from "./api";
import { describeServerError, isUnauthorized, isUnreachable, serverClient } from "./server-client";

/** Renew this far ahead of the expiry: a laptop closed for a fortnight still ships on reopen. */
export const RENEW_BEFORE_MS = 14 * 24 * 60 * 60 * 1000;

export function targetOf(hosted: HostedSource, name: string): ServerTarget {
  return {
    name,
    url: hosted.server_url.replace(/\/+$/, ""),
    owner: hosted.owner,
    token: hosted.token,
    source_id: hosted.source.id,
    hosted: true,
    token_expires_at: hosted.expires_at,
  };
}

/** The token tried against the server it is for (`GET /v1/me`), as joining a server store tries a
 * pasted one: a token Dosu minted but its server does not accept (the two do not share a
 * secret yet, or the server is down) would otherwise be saved and fail at every ship. The
 * fault is on Dosu's side either way, and the message says so. */
export async function checkWithServer(target: ServerTarget, fetchImpl: FetchLike): Promise<void> {
  let owner: string;
  try {
    ({ owner } = await serverClient(target, fetchImpl).me());
  } catch (err) {
    if (isUnauthorized(err)) {
      throw new CliUsageError(
        `Dosu's sessiondb at ${target.url} did not accept the token Dosu minted; that is Dosu's to fix, not yours. Nothing was saved.`,
      );
    }
    throw new CliUsageError(
      `Dosu's sessiondb at ${target.url} ${
        isUnreachable(err) ? describeServerError(err) : `answered ${describeServerError(err)}`
      }. Nothing was saved; try again later.`,
    );
  }
  if (owner !== target.owner) {
    throw new CliUsageError(
      `Dosu's sessiondb at ${target.url} read the token as ${owner}, not ${target.owner}. Nothing was saved.`,
    );
  }
}

type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

/** Whether a hosted token should be renewed now: it is hosted and expires within the window,
 * or its expiry is unknown. A token from a server's `.env` is never renewed. */
export function hostedTokenNeedsRenewal(target: ServerTarget, now: Date = new Date()): boolean {
  if (!target.hosted) return false;
  if (!target.token_expires_at) return true;
  const expires = Date.parse(target.token_expires_at);
  return Number.isNaN(expires) || expires - now.getTime() < RENEW_BEFORE_MS;
}

/** A fresh token for a hosted target whose expiry is near, saved in place once the server has
 * accepted it; the target as it was when Dosu cannot be asked (not logged in, offline, or an
 * error) or its server refuses the new token, so the run goes on with what it has. Never
 * throws. */
export async function renewHostedToken(
  cfg: Config,
  target: ServerTarget,
  api: Pick<SourcesApi, "hosted"> | undefined,
  now: Date = new Date(),
  fetchImpl: FetchLike = fetch,
): Promise<ServerTarget> {
  if (!hostedTokenNeedsRenewal(target, now)) return target;
  if (!api) {
    logger.debug("sources", `hosted token for ${target.name} not renewed: not logged in to Dosu`);
    return target;
  }
  try {
    const hosted = await api.hosted();
    const renewed = { ...target, ...targetOf(hosted, target.name) };
    await checkWithServer(renewed, fetchImpl);
    cfg.targets = configuredTargets(cfg).map((t) => (t.name === target.name ? renewed : t));
    saveConfig(cfg);
    logger.info("sources", `hosted token for ${target.name} renewed until ${hosted.expires_at}`);
    return renewed;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    logger.warn("sources", `hosted token for ${target.name} not renewed: ${message}`);
    return target;
  }
}
