/** Dosu's own sessiondb, for a user who does not host a server. One call to the Dosu login
 * (`POST /v1/memory/sources/hosted`) does what the server wizard does by hand: the backend
 * mints a token for the user's folder on the server it runs, and registers that folder as a
 * source it reads with its own key. This machine gets back a target like any other, named
 * `dosu`; nothing is pasted, and no bucket credential is anywhere near the laptop.
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

/** The target's name in config: `dosu sync --target dosu`. */
export const HOSTED_TARGET_NAME = "dosu";

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

/** Set this login up on Dosu's sessiondb and save it as a target. Saved before anything else
 * can fail, so a second run (another machine, a new token) replaces it in place. */
export async function setupHostedTarget(
  cfg: Config,
  api: SourcesApi,
  options: HostedSetupOptions = {},
): Promise<HostedSetupResult> {
  const hosted = await askDosu(api);
  const name = options.name ?? HOSTED_TARGET_NAME;
  const target = targetOf(hosted, name);
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
