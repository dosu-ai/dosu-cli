/** Dosu's own sessiondb, for a user who does not host a server. One call to the Dosu login
 * (`POST /v1/memory/sources/hosted`) does what the server wizard does by hand: the backend
 * mints a token for the user's folder on the server it runs, and registers that folder as a
 * source it reads with its own key. This machine gets back a target like any other, named
 * `dosu`, after trying the token against the server as the wizard tries a pasted one; nothing
 * is pasted, and no bucket credential is anywhere near the laptop.
 *
 * The token expires. The backend renews it on the same call, so `dosu sync` asks again when
 * the expiry is near (`renewHostedToken`); a run that cannot reach Dosu ships with the token
 * it has. */

import { CliUsageError } from "../cli/errors";
import { type Config, saveConfig } from "../config/config";
import type { ServerTarget } from "../config/schema";
import { configuredTargets } from "../config/targets";
import { logger } from "../debug/logger";
import { type HostedSource, type SourcesApi, SourcesApiError } from "./api";
import { describeServerError, isUnauthorized, isUnreachable, serverClient } from "./server-client";

/** The target's name in config: `dosu sync --target dosu`. */
const HOSTED_TARGET_NAME = "dosu";

/** Renew this far ahead of the expiry: a laptop closed for a fortnight still ships on reopen. */
export const RENEW_BEFORE_MS = 14 * 24 * 60 * 60 * 1000;

/** The Dosu this login talks to runs no sessiondb (HTTP 404): the user needs their own server. */
export class HostedUnavailable extends CliUsageError {
  constructor(backendUrl: string) {
    super(`Dosu at ${backendUrl} does not host a sessiondb; sessions need your own server`);
    this.name = "HostedUnavailable";
  }
}

export interface HostedSetupOptions {
  /** Make it where `dosu sync` ships. Default: yes when it is the only target. */
  makeDefault?: boolean;
  name?: string;
}

export interface HostedSetupResult {
  target: ServerTarget;
  source: HostedSource["source"];
}

async function askDosu(api: SourcesApi): Promise<HostedSource> {
  try {
    return await api.hosted();
  } catch (err) {
    if (err instanceof SourcesApiError && err.status === 404) {
      throw new HostedUnavailable(api.backendUrl);
    }
    const message = err instanceof Error ? err.message : String(err);
    throw new CliUsageError(`Dosu could not set up its sessiondb for you: ${message}`);
  }
}

function targetOf(hosted: HostedSource, name: string): ServerTarget {
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

/** The token tried against the server it is for (`GET /v1/me`), as the server wizard tries a
 * pasted one: a token Dosu minted but its server does not accept (the two do not share a
 * secret yet, or the server is down) would otherwise be saved and fail at every ship. The
 * fault is on Dosu's side either way, and the message says so. */
async function checkWithServer(target: ServerTarget, fetchImpl: FetchLike): Promise<void> {
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

/** Set this login up on Dosu's sessiondb and save it as a target, once the server has
 * accepted the token. A second run (another machine, a new token) replaces it in place. */
export async function setupHostedTarget(
  cfg: Config,
  api: SourcesApi,
  options: HostedSetupOptions = {},
  fetchImpl: FetchLike = fetch,
): Promise<HostedSetupResult> {
  const hosted = await askDosu(api);
  const name = options.name ?? HOSTED_TARGET_NAME;
  const target = targetOf(hosted, name);
  await checkWithServer(target, fetchImpl);
  const others = configuredTargets(cfg).filter((t) => t.name !== name);
  cfg.targets = [...others, target];
  const makeDefault = options.makeDefault ?? (others.length === 0 || cfg.default_target === name);
  if (makeDefault) cfg.default_target = name;
  saveConfig(cfg);
  logger.info("sources", `hosted target "${name}" saved: ${target.url} as ${target.owner}`);
  return { target, source: hosted.source };
}

/** Whether a hosted token should be renewed now: it is hosted and expires within the window,
 * or its expiry is unknown. A token from a server's `.env` is never renewed. */
export function hostedTokenNeedsRenewal(target: ServerTarget, now: Date = new Date()): boolean {
  if (!target.hosted) return false;
  if (!target.token_expires_at) return true;
  const expires = Date.parse(target.token_expires_at);
  return Number.isNaN(expires) || expires - now.getTime() < RENEW_BEFORE_MS;
}

/** A fresh token for a hosted target whose expiry is near, saved in place; the target as it
 * was when Dosu cannot be asked (not logged in, offline, or an error), so the run goes on
 * with what it has. Never throws. */
export async function renewHostedToken(
  cfg: Config,
  target: ServerTarget,
  api: SourcesApi | undefined,
  now: Date = new Date(),
): Promise<ServerTarget> {
  if (!hostedTokenNeedsRenewal(target, now)) return target;
  if (!api) {
    logger.debug("sources", `hosted token for ${target.name} not renewed: not logged in to Dosu`);
    return target;
  }
  try {
    const hosted = await api.hosted();
    const renewed = { ...target, ...targetOf(hosted, target.name) };
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
