/** Where the org's sessions live: the org's session store, which only an org admin sets. There is
 * no bucket of a member's own; every member's machine ships to the org's store or nowhere.
 *
 * `decideStore` is setup's first question for everyone (`dosu setup`, `dosu sources setup`):
 *
 * - the org has a store (an admin set one): that is where sessions live; nothing is asked.
 * - none, and the caller is an org admin: "Where do sessions live?" sets it (`chooseStore`, then
 *   `PUT /v1/memory/store`): Dosu's sessiondb, the org's own sessiondb server, or the org's bucket.
 *   For a bucket, Dosu gets a READ-ONLY key and looks first (`POST /detect`); the admin confirms
 *   what it found or names the format of the raw files other tools drop there (`--agent`).
 * - none, and the caller is a member: Dosu's hosted sessiondb when this installation runs one
 *   (the org's default until an admin sets a store), else nowhere, and only an admin can fix that.
 *
 * `dosu sources store setup` is the admin's direct path to `chooseStore`. */

import { CliUsageError } from "../cli/errors";
import type { Config } from "../config/config";
import { getWebAppURL } from "../config/constants";
import { info, wrapLog } from "../setup/styles";
import * as p from "../tui/prompts";
import {
  type Detection,
  type SessionStore,
  type SetStoreRequest,
  type SourceAgent,
  type SourcesApi,
  SourcesApiError,
  type StoreApi,
  type StoreKind,
} from "./api";
import { type BucketLocation, bucketOfStorage, detectBody, READ_KEY_NOTE } from "./bucket";
import { askBucketUrl, normalizeBucketUrl } from "./bucket-wizard";
import { settleDetection } from "./detect";
import {
  type Asker,
  asker,
  askKeyPair,
  envCredentials,
  type KeyPair,
  required,
  WizardCancelled,
} from "./prompts";
import { normalizeServerUrl } from "./server-client";
import { describeStore, isOrgAdmin, lookUpStore } from "./store";

/** The store's answers given up front (flags, environment); the rest are asked. */
export interface StoreChoiceInput {
  kind?: StoreKind;
  /** A server store: the server's URL. */
  server?: string;
  /** A bucket store's bucket, or the bucket a server store's server writes. */
  bucket?: string;
  region?: string;
  accountId?: string;
  endpoint?: string;
  /** Dosu's read-only key to the bucket. */
  read?: KeyPair;
  tokenSecret?: string;
  clearTokenSecret?: boolean;
  /** A bucket store: the format of every raw file other tools drop in it. */
  agent?: SourceAgent;
  /** Never prompt: a missing answer is an error. */
  yes?: boolean;
}

/** The store the flags name: `--hosted`, `--server <url>` (with the bucket it writes), or
 * `--bucket <url>`; undefined when they name none. */
export function storeKindOf(flags: {
  hosted?: boolean;
  server?: string;
  bucket?: string;
}): StoreKind | undefined {
  if (flags.hosted && (flags.server || flags.bucket)) {
    throw new CliUsageError("--hosted is Dosu's: --server and --bucket are for the org's own");
  }
  if (flags.hosted) return "hosted";
  if (flags.server) return "server";
  if (flags.bucket) return "bucket";
  return undefined;
}

/** Flags that only go with some kinds of store, checked once the kind is known. */
function checkFlags(kind: StoreKind | undefined, input: StoreChoiceInput): void {
  if (input.tokenSecret && input.clearTokenSecret) {
    throw new CliUsageError("--token-secret and --clear-token-secret contradict");
  }
  if (kind === undefined) return;
  if (kind !== "server" && (input.tokenSecret || input.clearTokenSecret)) {
    throw new CliUsageError("the token secret is a server's: only a server store has one");
  }
  if (kind !== "bucket" && input.agent) {
    throw new CliUsageError(
      "--agent names the format of the raw files other tools drop in the org's bucket: it goes with --bucket",
    );
  }
}

/** Step 1's question. */
function askStoreKind(ask: Asker): Promise<StoreKind> {
  return ask.select<StoreKind>(
    {
      message: "Where do sessions live?",
      options: [
        {
          value: "hosted" as const,
          label: "Dosu's sessiondb (recommended)",
          hint: "nothing to run; Dosu stores the org's sessions and learns from them",
        },
        {
          value: "server" as const,
          label: "My own sessiondb server",
          hint: "the org's server redacts and writes the org's bucket; members ship to it",
        },
        {
          value: "bucket" as const,
          label: "My bucket (S3 / R2)",
          hint: "the org's bucket: members write their own folder, other tools can drop logs in it",
        },
      ],
    },
    undefined,
  );
}

/** The bucket, and how to reach it: the URL, then a region (S3) or account (R2) and endpoint. */
async function askLocation(
  ask: Asker,
  input: StoreChoiceInput,
  what: string,
): Promise<BucketLocation> {
  const given = await askBucketUrl(ask, input.bucket, what);
  const url = normalizeBucketUrl(given);
  if (!url) throw new CliUsageError(`not a bucket URL: ${given}`);
  let region: string | undefined;
  let accountId: string | undefined;
  let endpoint = input.endpoint;
  if (url.startsWith("r2://")) {
    if (!endpoint) {
      accountId = (
        await ask.text(
          { message: "Cloudflare account id", validate: required("The account id") },
          input.accountId,
        )
      ).trim();
    }
  } else {
    region = (
      await ask.text(
        { message: "AWS region", initialValue: "us-east-1", validate: required("The region") },
        input.region,
      )
    ).trim();
    endpoint ??= (
      await ask.text(
        {
          message: "S3-compatible endpoint (blank for AWS)",
          placeholder: "https://minio.internal:9000",
          initialValue: "",
        },
        undefined,
      )
    ).trim();
  }
  // The URL matched normalizeBucketUrl, which bucketOfStorage parses.
  const parsed = bucketOfStorage({ url, ...(endpoint ? { endpoint } : {}) }) as NonNullable<
    ReturnType<typeof bucketOfStorage>
  >;
  return {
    url,
    ...parsed,
    ...(region ? { region } : {}),
    ...(accountId ? { accountId } : {}),
    ...(endpoint ? { endpoint } : {}),
  };
}

const READ_KEYS = "Dosu's read-only keys (GetObject + ListBucket)";

/** Dosu's read key: given, `DOSU_SOURCE_*`, or asked. */
function readKey(ask: Asker, input: StoreChoiceInput): Promise<KeyPair> {
  const known = input.read ?? envCredentials("DOSU_SOURCE");
  return known ? Promise.resolve(known) : askKeyPair(ask, READ_KEYS, undefined);
}

/** The location as `PUT /v1/memory/store` names it. */
function bucketFields(location: BucketLocation, read: KeyPair): SetStoreRequest {
  const { kind, ...rest } = detectBody(location, read);
  return { kind: "bucket", bucket_kind: kind, ...rest };
}

/** What step 1 settled: the store to set, and what Dosu found in a bucket store. */
export interface ChosenStore {
  body: SetStoreRequest;
  detection?: Detection;
}

export interface ChooseContext {
  /** Dosu's look at a bucket (`POST /detect`); without it a bucket store is set unseen. */
  sources?: Pick<SourcesApi, "detect">;
  /** The store set now, if any: a server store keeps its token secret, and a bucket store's own
   * raw scan is told apart from another connection's. */
  current?: SessionStore;
  /** Where what Dosu found is told (default: the prompt log). */
  say?: (line: string) => void;
}

/** Step 1 for an org admin: the kind of store, where it is, and Dosu's read key; for a bucket,
 * what Dosu finds there, confirmed or given the raw files' format. Null when the admin cancelled
 * or declined what Dosu found. */
export async function chooseStore(
  input: StoreChoiceInput,
  ctx: ChooseContext = {},
  io: p.PromptIO = {},
): Promise<ChosenStore | null> {
  try {
    return await choose(input, ctx, io);
  } catch (err) {
    if (err instanceof WizardCancelled) return null;
    throw err;
  }
}

async function choose(
  input: StoreChoiceInput,
  ctx: ChooseContext,
  io: p.PromptIO,
): Promise<ChosenStore | null> {
  checkFlags(input.kind, input);
  const yes = input.yes ?? false;
  const ask = asker(yes, io);
  let kind = input.kind;
  if (kind === undefined) {
    if (yes) {
      throw new CliUsageError(
        "say where the org's sessions live: --hosted (Dosu's sessiondb), --server <url> with --bucket (the org's sessiondb server and the bucket it writes) or --bucket <url> (the org's bucket)",
      );
    }
    kind = await askStoreKind(ask);
    checkFlags(kind, input);
  }
  if (kind === "hosted") return { body: { kind } };
  if (kind === "server") return { body: await serverStore(ask, input, ctx.current) };
  return bucketStore(ask, input, ctx, io);
}

async function serverStore(
  ask: Asker,
  input: StoreChoiceInput,
  current: SessionStore | undefined,
): Promise<SetStoreRequest> {
  const given = await ask.text(
    {
      message: "Server URL",
      placeholder: "https://sessions.example.com",
      validate: (value) =>
        normalizeServerUrl(value) ? undefined : "An https:// URL (http:// only to localhost)",
    },
    input.server,
  );
  const serverUrl = normalizeServerUrl(given);
  if (!serverUrl) throw new CliUsageError(`not a server URL: ${given}`);
  const location = await askLocation(ask, input, "The bucket the server writes");
  const read = await readKey(ask, input);
  let tokenSecret = input.clearTokenSecret
    ? undefined
    : (input.tokenSecret ?? process.env.DOSU_STORE_TOKEN_SECRET);
  // Dosu keeps the secret it has when this is the same server and none is given.
  const keeps =
    current?.kind === "server" && current.issues_tokens && current.server_url === serverUrl;
  if (tokenSecret === undefined && !input.clearTokenSecret && !input.yes) {
    tokenSecret =
      (
        await ask.text(
          {
            message: keeps
              ? "The server's SESSIONDB_TOKEN_SECRET (blank: keep the one Dosu has)"
              : "The server's SESSIONDB_TOKEN_SECRET, so Dosu signs each member's token (blank: you hand out tokens yourself)",
            mask: true,
            initialValue: "",
          },
          undefined,
        )
      ).trim() || undefined;
  }
  return {
    ...bucketFields(location, read),
    kind: "server",
    server_url: serverUrl,
    ...(tokenSecret ? { token_secret: tokenSecret } : {}),
    ...(input.clearTokenSecret ? { clear_token_secret: true } : {}),
  };
}

/** Retry, another key, or cancel, after Dosu could not look at the bucket. */
async function whatNow(ask: Asker, badKeys: boolean): Promise<"retry" | "keys" | "cancel"> {
  const retry = { value: "retry" as const, label: "Try again" };
  const keys = { value: "keys" as const, label: "Give Dosu a different read-only key" };
  return ask.select(
    {
      message: "What now?",
      options: [...(badKeys ? [keys, retry] : [retry, keys]), { value: "cancel", label: "Cancel" }],
    },
    undefined,
  );
}

async function bucketStore(
  ask: Asker,
  input: StoreChoiceInput,
  ctx: ChooseContext,
  io: p.PromptIO,
): Promise<ChosenStore | null> {
  const location = await askLocation(ask, input, "Bucket");
  let read = input.read ?? envCredentials("DOSU_SOURCE");
  if (!read) {
    p.log.info(wrapLog(READ_KEY_NOTE), io);
    read = await askKeyPair(ask, READ_KEYS, undefined);
  }
  if (!ctx.sources) {
    return {
      body: { ...bucketFields(location, read), ...(input.agent ? { agent: input.agent } : {}) },
    };
  }
  const say = ctx.say ?? ((line: string) => p.log.info(wrapLog(line), io));
  const s = p.spinner(io);
  for (;;) {
    let spinning = true;
    s.start(`Looking at ${location.url}...`);
    try {
      const settled = await settleDetection(ctx.sources, detectBody(location, read), {
        ...(input.agent ? { agent: input.agent } : {}),
        interactive: !input.yes,
        ask,
        rawSourceId: ctx.current?.raw_source_id ?? null,
        say: (line) => {
          s.stop("Dosu looked at the bucket");
          spinning = false;
          say(line);
        },
      });
      return {
        body: {
          ...bucketFields(location, read),
          ...(settled.agent ? { agent: settled.agent } : {}),
        },
        detection: settled.detection,
      };
    } catch (err) {
      if (spinning) s.stop("Dosu could not look at the bucket", 1);
      if (err instanceof WizardCancelled) throw err;
      if (err instanceof SourcesApiError && err.status === 403) {
        throw new CliUsageError("only an org admin can set the org's session store");
      }
      const badKeys = err instanceof SourcesApiError && (err.status === 400 || err.status === 422);
      const why = badKeys
        ? `Dosu could not read ${location.url} with that key: ${(err as Error).message}`
        : err instanceof SourcesApiError
          ? `Dosu did not look at the bucket: ${err.message}`
          : `Could not reach Dosu: ${err instanceof Error ? err.message : String(err)}`;
      if (input.yes) throw new CliUsageError(why);
      p.log.error(wrapLog(why), io);
      const next = await whatNow(ask, badKeys);
      if (next === "cancel") return null;
      if (next === "keys") read = await askKeyPair(ask, READ_KEYS, undefined);
    }
  }
}

/** `PUT /v1/memory/store`, with Dosu's refusal as what to do about it. */
export async function setStore(api: StoreApi, body: SetStoreRequest): Promise<SessionStore> {
  try {
    return await api.set(body);
  } catch (err) {
    if (err instanceof SourcesApiError) {
      throw new CliUsageError(
        err.status === 403
          ? "only an org admin can set the org's session store"
          : `Dosu did not set the org's session store: ${err.message}`,
      );
    }
    throw err;
  }
}

/** What an admin who just set the store should know, one line each. */
export function storeNotes(store: SessionStore): string[] {
  const notes: string[] = [];
  if (store.kind === "bucket") {
    notes.push(
      store.raw_source_id
        ? `Dosu reads members' folders and other tools' raw logs (${
            store.raw_agent ? `read as ${store.raw_agent}` : "each file's format detected"
          }).`
        : "Dosu reads members' folders.",
      "A write key to the bucket can add to the org's memory; Dosu still redacts every session.",
      `Scope each member's write key to ${store.url}/owners/<their folder>/.`,
    );
  } else if (store.kind === "server" && !store.issues_tokens) {
    notes.push("Give each member their own token from the server's SESSIONDB_TOKENS.");
  }
  notes.push("Members run 'dosu setup' to join.");
  return notes;
}

/** What a member whose org has nowhere for sessions to go is told. */
function noStoreMessage(cfg: Config): string {
  const org = cfg.active_account?.target?.org_id;
  const page = org ? `${getWebAppURL()}/${org}/sources` : getWebAppURL();
  return `Your org has no session store yet, so your sessions have nowhere to go. An org admin sets one with ${info("dosu sources store setup")} or on the Sources page:\n  ${page}\nThen run ${info("dosu setup")} again.`;
}

/** Where this machine's sessions would go, per the rules at the top: the store (and whether this
 * run set it), the admin's cancel, or why there is nowhere. */
export type StoreDecision =
  | { store: SessionStore; set?: ChosenStore }
  | { cancelled: true }
  | { noStore: string };

/** Whether the flags say something about the store itself, rather than this machine. */
function namesStore(input: StoreChoiceInput): boolean {
  return Boolean(
    input.kind ||
      input.read ||
      input.agent ||
      input.tokenSecret ||
      input.clearTokenSecret ||
      input.region ||
      input.accountId ||
      input.endpoint,
  );
}

/** Flags that only restate the store as it is are fine; anything else would change it. */
function restatesStore(input: StoreChoiceInput, store: SessionStore): boolean {
  if (input.read || input.agent || input.tokenSecret || input.clearTokenSecret) return false;
  if (input.kind && input.kind !== store.kind) return false;
  if (input.server && normalizeServerUrl(input.server) !== store.server_url) return false;
  if (input.bucket && normalizeBucketUrl(input.bucket) !== store.url) return false;
  return true;
}

export async function decideStore(
  cfg: Config,
  stores: StoreApi,
  sources: Pick<SourcesApi, "detect"> | undefined,
  input: StoreChoiceInput,
  io: p.PromptIO = {},
  say?: (line: string) => void,
): Promise<StoreDecision> {
  checkFlags(input.kind, input);
  const found = await lookUpStore(stores);
  if ("error" in found) {
    throw new CliUsageError(`Could not ask Dosu where the org's sessions live: ${found.error}`);
  }
  const store = "store" in found ? found.store : undefined;
  if (store?.configured) {
    if (namesStore(input) && !restatesStore(input, store)) {
      throw new CliUsageError(
        `the org's sessions already go to ${describeStore(store)}; an org admin changes that with 'dosu sources store setup'`,
      );
    }
    return { store };
  }
  if (!store) return { noStore: noStoreMessage(cfg) };
  if (!isOrgAdmin(store)) {
    // The hosted default: what members use until an admin sets a store.
    if (namesStore(input) && !(input.kind === "hosted" && restatesStore(input, store))) {
      throw new CliUsageError(
        "only an org admin sets where the org's sessions live, with 'dosu sources store setup'; until one does, your org uses Dosu's sessiondb ('dosu sources setup --hosted')",
      );
    }
    return { store };
  }
  // An admin with nothing to say under --yes keeps the hosted default as members would.
  if (input.yes && !namesStore(input)) return { store };
  const chosen = await chooseStore(
    input,
    { ...(sources ? { sources } : {}), current: store, ...(say ? { say } : {}) },
    io,
  );
  if (!chosen) return { cancelled: true };
  return { store: await setStore(stores, chosen.body), set: chosen };
}
