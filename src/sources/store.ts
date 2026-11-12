/** Joining the org's session store: what `dosu setup` does once an org admin has set one (in
 * `dosu setup`'s first step, `dosu sources store setup`, or the dashboard), or the org uses Dosu's
 * hosted sessiondb by default. Sessions always go to the org's store: there is no bucket of a
 * member's own. The store says where the org keeps its sessions and holds Dosu's read key;
 * enrolling (`POST /v1/memory/store/enroll`) makes Dosu read this member's own folder with it, so
 * the member never sees that key. What the member writes with is theirs alone:
 *
 * - a token Dosu mints, for a store that issues them (Dosu's sessiondb, or a server whose token
 *   secret the store holds): nothing to ask;
 * - a token the admin issued from the server's `SESSIONDB_TOKENS`: pasted, and enrolled under
 *   the owner the server reads it as;
 * - a write key to the bucket, scoped by the admin's bucket policy to the member's folder: the
 *   bucket wizard's questions, with the bucket filled in. The key stays on this machine.
 *
 * A folder name is first-come in the store; enrolling under another moves this member to it. */

import { CliUsageError } from "../cli/errors";
import { type Config, saveConfig } from "../config/config";
import type { BucketTarget, ServerTarget, SessionTarget } from "../config/schema";
import { configuredTargets } from "../config/targets";
import { logger } from "../debug/logger";
import { info, wrapLog } from "../setup/styles";
import * as p from "../tui/prompts";
import {
  type Enrollment,
  type HostedSource,
  type SessionStore,
  SourcesApiError,
  type StoreApi,
} from "./api";
import { bucketOfStorage } from "./bucket";
import { defaultOwner, runBucketWizard } from "./bucket-wizard";
import { checkWithServer, targetOf } from "./hosted";
import { asker, type KeyPair, required, WizardCancelled } from "./prompts";
import {
  describeServerError,
  isUnauthorized,
  isUnreachable,
  normalizeServerUrl,
  serverClient,
} from "./server-client";

/** The target's name in config when none is given: `dosu sync --target org`. */
const STORE_TARGET_NAME = "org";

const OWNER_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;

type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

export interface JoinStoreInput {
  /** A server store without a token secret: the token the admin issued. */
  token?: string;
  /** A bucket store: this member's folder (default: their user name). */
  owner?: string;
  /** A bucket store: the key this machine writes with. */
  write?: KeyPair;
  name?: string;
  makeDefault?: boolean;
  yes?: boolean;
}

export interface JoinStoreResult {
  target: SessionTarget;
  enrollment: Enrollment;
}

/** Where the org's store is, in one line. */
export function describeStore(store: SessionStore): string {
  if (store.kind === "hosted") return "Dosu's sessiondb";
  if (store.kind === "server") return `the org's sessiondb server ${store.server_url}`;
  return `the org's bucket ${store.url}`;
}

/** What Dosu says of the org's store: the store (set by an admin, or the hosted default when
 * `configured` is false), none at all (404: no store and no hosted sessiondb to fall back on), or
 * why it could not be asked. */
export type StoreLookup = { store: SessionStore } | { none: true } | { error: string };

export async function lookUpStore(api: StoreApi): Promise<StoreLookup> {
  try {
    return { store: await api.get() };
  } catch (err) {
    if (err instanceof SourcesApiError && err.status === 404) return { none: true };
    return { error: err instanceof Error ? err.message : String(err) };
  }
}

/** The store an org admin set, or undefined: none set (the hosted default is not one), or Dosu
 * cannot be asked. */
export async function orgStore(api: StoreApi | undefined): Promise<SessionStore | undefined> {
  if (!api) return undefined;
  const found = await lookUpStore(api);
  if ("error" in found) {
    logger.debug("sources", `no org session store: ${found.error}`);
    return undefined;
  }
  return "store" in found && found.store.configured ? found.store : undefined;
}

/** Whether this login is an org admin, who alone sets where the org's sessions live: Dosu says
 * so (`can_set`), the hosted default included. An older Dosu only lists a set store's members
 * to admins, so there an admin on the hosted default reads as a member. With no store at all
 * Dosu cannot say, and the caller is sent to `dosu sources store setup`. */
export function isOrgAdmin(store?: SessionStore): boolean {
  return Boolean(store?.can_set || store?.members);
}

/** An enrollment's minted token, in the shape the hosted renewal reads. */
function minted(enrollment: Enrollment): HostedSource {
  if (!enrollment.token || !enrollment.expires_at || !enrollment.server_url) {
    throw new CliUsageError("the org's session store no longer issues tokens");
  }
  return {
    server_url: enrollment.server_url,
    token: enrollment.token,
    owner: enrollment.owner,
    expires_at: enrollment.expires_at,
    source: enrollment.source,
  };
}

/** What `renewHostedToken` asks for a fresh token, for a target enrolled in the org store. */
export function storeTokenSource(api: StoreApi): { hosted(): Promise<HostedSource> } {
  return { hosted: async () => minted(await api.enroll()) };
}

function enrollError(err: unknown): CliUsageError {
  if (err instanceof SourcesApiError) {
    return new CliUsageError(`Dosu did not enroll you in the org's session store: ${err.message}`);
  }
  return new CliUsageError(
    `Could not reach Dosu to enroll you: ${err instanceof Error ? err.message : String(err)}`,
  );
}

/** Save `target`, replacing one of the same name, and make it the default when `makeDefault`. */
function saveTarget(cfg: Config, target: SessionTarget, makeDefault: boolean): void {
  const others = configuredTargets(cfg).filter((t) => t.name !== target.name);
  cfg.targets = [...others, target];
  if (makeDefault) cfg.default_target = target.name;
  saveConfig(cfg);
}

export async function joinOrgStore(
  cfg: Config,
  api: StoreApi,
  store: SessionStore,
  input: JoinStoreInput = {},
  io: p.PromptIO = {},
  fetchImpl: FetchLike = fetch,
): Promise<JoinStoreResult | null> {
  try {
    if (store.issues_tokens) return await joinMinted(cfg, api, input, fetchImpl);
    if (store.kind === "server") return await joinServer(cfg, api, store, input, io, fetchImpl);
    return await joinBucket(cfg, api, store, input, io, fetchImpl);
  } catch (err) {
    if (err instanceof WizardCancelled) return null;
    throw err;
  }
}

/** Dosu mints the token: enroll, check it with the server, save. */
async function joinMinted(
  cfg: Config,
  api: StoreApi,
  input: JoinStoreInput,
  fetchImpl: FetchLike,
): Promise<JoinStoreResult> {
  let enrollment: Enrollment;
  try {
    enrollment = await api.enroll();
  } catch (err) {
    throw enrollError(err);
  }
  const target: ServerTarget = {
    ...targetOf(minted(enrollment), input.name ?? STORE_TARGET_NAME),
    store: true,
  };
  await checkWithServer(target, fetchImpl);
  saveTarget(cfg, target, input.makeDefault !== false);
  logger.info(
    "sources",
    `org store target "${target.name}" saved: ${target.url} as ${target.owner}`,
  );
  return { target, enrollment };
}

/** A token the admin issued: ask for it, learn its owner from the server, and enroll under that
 * owner before anything is saved, so a token another member already holds ships nowhere. */
async function joinServer(
  cfg: Config,
  api: StoreApi,
  store: SessionStore,
  input: JoinStoreInput,
  io: p.PromptIO,
  fetchImpl: FetchLike,
): Promise<JoinStoreResult> {
  const url = normalizeServerUrl(store.server_url ?? "");
  if (!url) throw new CliUsageError(`the org's server URL is not usable: ${store.server_url}`);
  const ask = asker(input.yes ?? false, io);
  p.log.message(
    wrapLog(
      `Your org ships sessions through its sessiondb server ${url}. Paste the token your admin gave you; it is yours alone and writes only your folder.`,
    ),
    io,
  );
  const token = (
    await ask.text(
      { message: "Token", placeholder: "sdb_…", mask: true, validate: required("The token") },
      input.token,
    )
  ).trim();
  let me: Awaited<ReturnType<ReturnType<typeof serverClient>["me"]>>;
  try {
    me = await serverClient({ url, token }, fetchImpl).me();
  } catch (err) {
    if (isUnauthorized(err)) throw new CliUsageError(`${url} did not accept that token`);
    throw new CliUsageError(
      isUnreachable(err) ? describeServerError(err) : `${url} answered ${describeServerError(err)}`,
    );
  }
  const writes = bucketOfStorage(me.storage);
  if (!writes || writes.bucket !== store.bucket || writes.prefix !== store.prefix) {
    throw new CliUsageError(
      `${url} writes ${me.storage.url}, not the org's ${store.url}; ask your admin to fix the store with 'dosu sources store setup'`,
    );
  }
  let enrollment: Enrollment;
  try {
    enrollment = await api.enroll(me.owner);
  } catch (err) {
    if (err instanceof SourcesApiError && err.status === 409) {
      throw new CliUsageError(
        `the token is for ${me.owner}, which another member of the org already ships as; ask your admin for a token of your own`,
      );
    }
    throw enrollError(err);
  }
  const target: ServerTarget = {
    name: input.name ?? STORE_TARGET_NAME,
    url,
    owner: me.owner,
    token,
    source_id: enrollment.source.id,
    store: true,
  };
  saveTarget(cfg, target, input.makeDefault !== false);
  return { target, enrollment };
}

/** A bucket written from this machine: claim a folder (first come), then the bucket wizard
 * with the bucket filled in and Dosu's half already done. */
async function joinBucket(
  cfg: Config,
  api: StoreApi,
  store: SessionStore,
  input: JoinStoreInput,
  io: p.PromptIO,
  fetchImpl: FetchLike,
): Promise<JoinStoreResult> {
  if (!store.url) throw new CliUsageError("the org's session store names no bucket");
  const ask = asker(input.yes ?? false, io);
  p.log.message(
    wrapLog(
      `Your org keeps sessions in its bucket ${store.url}. They are redacted on this machine and written to your own folder with a write key your admin gave you; Dosu reads them with the org's key.`,
    ),
    io,
  );
  let given = input.owner;
  let enrollment: Enrollment;
  for (;;) {
    const owner = (
      await ask.text(
        {
          message: "Your folder in the bucket (owner)",
          initialValue: store.owner ?? defaultOwner(),
          validate: (value) =>
            OWNER_RE.test(value.trim()) ? undefined : "letters, digits, . _ - (one path segment)",
        },
        given,
      )
    ).trim();
    if (!OWNER_RE.test(owner)) throw new CliUsageError(`not an owner name: ${owner}`);
    try {
      enrollment = await api.enroll(owner);
      break;
    } catch (err) {
      const taken = err instanceof SourcesApiError && err.status === 409;
      if (!taken || input.yes) throw enrollError(err);
      p.log.warn(wrapLog(`${owner} is another member's folder; pick another.`), io);
      given = undefined;
    }
  }
  const result = await runBucketWizard(
    cfg,
    {
      bucket: store.url,
      ...(store.region ? { region: store.region } : {}),
      ...(store.account_id ? { accountId: store.account_id } : {}),
      ...(store.endpoint ? { endpoint: store.endpoint } : {}),
      owner: enrollment.owner,
      ...(input.write ? { write: input.write } : {}),
      name: input.name ?? STORE_TARGET_NAME,
      ...(input.makeDefault === false ? { makeDefault: false } : {}),
      ...(input.yes ? { yes: true } : {}),
    },
    io,
    fetchImpl,
  );
  if (!result) throw new WizardCancelled();
  const target: BucketTarget = { ...result.target, source_id: enrollment.source.id };
  // The wizard already asked whether this is the default.
  saveTarget(cfg, target, false);
  p.log.info(
    wrapLog(
      `Dosu reads ${info(`${store.url}/owners/${enrollment.owner}`)} with the org's key and keeps only what it learns.`,
    ),
    io,
  );
  return { target, enrollment };
}
