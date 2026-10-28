/** The "ship through a sessiondb server" flow, the third answer to setup's storage question.
 * The server (see sessiondb's docs/server.md) holds the bucket and its write keys; this machine
 * holds only a token the server's admin minted. The flow checks the token, finds out which
 * bucket the server writes to (offering to link one if none is), saves the target, and then,
 * exactly as for a bucket written from here, asks Dosu to read that bucket with its own
 * read-only keys. */

import { CliUsageError } from "../cli/errors";
import { type Config, saveConfig } from "../config/config";
import type { BucketTarget } from "../config/schema";
import { configuredTargets, isServerTarget } from "../config/targets";
import { logger } from "../debug/logger";
import { info, wrapLog } from "../setup/styles";
import { serverError } from "../store/remote";
import * as p from "../tui/prompts";
import { sourcesApi } from "./api";
import {
  type Asker,
  asker,
  askKeyPair,
  type BucketProvider,
  type BucketWizardResult,
  connectBucketToDosu,
  PROVIDERS,
  preflight,
  required,
  targetUrl,
  WizardCancelled,
} from "./wizard";

export interface ServerWizardInput {
  /** `https://sessions.example.com` */
  server?: string;
  token?: string;
  /** How the target is named in config and on the command line. */
  name?: string;
  /** Register the server's bucket with Dosu (needs the login). Default: yes when logged in. */
  connect?: boolean;
  /** Make it where `dosu sync` ships. Default: yes. */
  makeDefault?: boolean;
  /** Never prompt: a missing answer is an error. */
  yes?: boolean;
}

/** What `GET /v1/me` says about the token's owner and the bucket the server writes for it. */
interface ServerIdentity {
  owner: string;
  storage: {
    url: string;
    region?: string;
    account_id?: string;
    endpoint?: string;
    credentials: "static" | "env" | "none";
  } | null;
}

type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

const URL_RE = /^https?:\/\/[^\s/]+(?::\d+)?(?:\/[^\s]*)?$/;

export function normalizeServerUrl(value: string): string | undefined {
  const url = value.trim().replace(/\/+$/, "");
  return URL_RE.test(url) ? url : undefined;
}

/** `r2://bucket/prefix` → what Dosu's connect call needs; a plain `s3://` with an endpoint is
 * S3-compatible. `file://` cannot be connected (Dosu cannot read a folder on the server). */
export function bucketOfStorage(
  storage: NonNullable<ServerIdentity["storage"]>,
): { provider: BucketProvider; bucket: string; prefix: string } | undefined {
  const m = /^(s3|r2):\/\/([^/]+)(?:\/(.*))?$/.exec(storage.url);
  if (!m) return undefined;
  const provider: BucketProvider = m[1] === "r2" ? "r2" : storage.endpoint ? "compatible" : "s3";
  return { provider, bucket: m[2] as string, prefix: (m[3] ?? "").replace(/^\/+|\/+$/g, "") };
}

/** The bucket a target stands for, as Dosu is told about it: a bucket target's own URL and
 * fields; for a server target, what the server reports it writes to (`GET /v1/storage`). */
export async function bucketOfTarget(
  target: BucketTarget,
  fetchImpl: FetchLike = fetch,
): Promise<{
  url: string;
  scheme: "s3" | "r2";
  bucket: string;
  prefix: string;
  region?: string;
  account_id?: string;
  endpoint?: string;
}> {
  let storage: NonNullable<ServerIdentity["storage"]>;
  if (isServerTarget(target)) {
    if (!target.token)
      throw new CliUsageError(`target ${target.name} has no token; run 'dosu setup'`);
    let response: Response;
    try {
      response = await fetchImpl(`${target.url.replace(/\/$/, "")}/v1/storage`, {
        headers: { Authorization: `Bearer ${target.token}` },
        signal: AbortSignal.timeout(15_000),
      });
    } catch (err) {
      throw new CliUsageError(
        `could not reach ${target.url}: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
    if (response.status === 404) {
      throw new CliUsageError(
        `the server ${target.url} has no bucket linked for ${target.owner} yet; link one (PUT /v1/storage) or rerun 'dosu sources setup --server ${target.url}'`,
      );
    }
    if (!response.ok) {
      throw new CliUsageError(`${target.url} answered ${await serverError(response)}`);
    }
    storage = (await response.json()) as NonNullable<ServerIdentity["storage"]>;
  } else {
    storage = {
      url: target.url,
      region: target.region,
      account_id: target.account_id,
      endpoint: target.endpoint,
      credentials: "none",
    };
  }
  const parsed = bucketOfStorage(storage);
  if (!parsed) {
    throw new CliUsageError(`${storage.url} is not a bucket Dosu can read (s3:// or r2://)`);
  }
  return {
    url: storage.url,
    scheme: parsed.provider === "r2" ? "r2" : "s3",
    bucket: parsed.bucket,
    prefix: parsed.prefix,
    ...(storage.region ? { region: storage.region } : {}),
    ...(storage.account_id ? { account_id: storage.account_id } : {}),
    ...(storage.endpoint ? { endpoint: storage.endpoint } : {}),
  };
}

async function identity(
  fetchImpl: FetchLike,
  url: string,
  token: string,
): Promise<ServerIdentity | { error: string; unauthorized: boolean }> {
  try {
    const response = await fetchImpl(`${url}/v1/me`, {
      headers: { Authorization: `Bearer ${token}` },
      signal: AbortSignal.timeout(15_000),
    });
    if (response.status === 401) {
      return { error: "the server did not accept that token", unauthorized: true };
    }
    if (!response.ok) {
      return { error: `${url} answered ${await serverError(response)}`, unauthorized: false };
    }
    return (await response.json()) as ServerIdentity;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return { error: `could not reach ${url}: ${message}`, unauthorized: false };
  }
}

/** Link a bucket on the server (`PUT /v1/storage`), asking for its details and write keys. */
async function linkBucket(
  ask: Asker,
  fetchImpl: FetchLike,
  url: string,
  token: string,
  io: p.PromptIO,
  s: ReturnType<typeof p.spinner>,
): Promise<NonNullable<ServerIdentity["storage"]>> {
  const provider = await ask.select(
    { message: "Where should the server keep your sessions?", options: PROVIDERS },
    undefined,
  );
  const bucket = (
    await ask.text(
      {
        message: "Bucket name",
        placeholder: "my-agent-sessions",
        validate: required("The bucket"),
      },
      undefined,
    )
  ).trim();
  const prefix = (
    await ask.text(
      {
        message: "Prefix inside the bucket",
        initialValue: "dosu",
        validate: (value) => (/^[^\s]*$/.test(value) ? undefined : "No spaces in a prefix"),
      },
      undefined,
    )
  ).trim();
  let region: string | undefined;
  let account_id: string | undefined;
  let endpoint: string | undefined;
  if (provider === "s3") {
    region = (
      await ask.text(
        { message: "AWS region", initialValue: "us-east-1", validate: required("The region") },
        undefined,
      )
    ).trim();
  } else if (provider === "r2") {
    account_id = (
      await ask.text(
        {
          message: "Cloudflare account id",
          placeholder: "32 hex characters, from the R2 dashboard",
          validate: required("The account id"),
        },
        undefined,
      )
    ).trim();
  } else {
    endpoint = (
      await ask.text(
        {
          message: "S3 endpoint URL",
          placeholder: "https://s3.example.com",
          validate: required("The endpoint"),
        },
        undefined,
      )
    ).trim();
  }
  for (;;) {
    const write = await askKeyPair(ask, "Keys the server writes with", undefined);
    s.start("Asking the server to write a probe object...");
    const response = await fetchImpl(`${url}/v1/storage`, {
      method: "PUT",
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        url: targetUrl(provider, bucket, prefix),
        ...(region ? { region } : {}),
        ...(account_id ? { account_id } : {}),
        ...(endpoint ? { endpoint } : {}),
        ...write,
      }),
      signal: AbortSignal.timeout(60_000),
    }).catch((err: unknown) => {
      throw new CliUsageError(
        `could not reach ${url}: ${err instanceof Error ? err.message : String(err)}`,
      );
    });
    if (response.ok) {
      const storage = (await response.json()) as NonNullable<ServerIdentity["storage"]>;
      s.stop(`The server writes to ${storage.url}`);
      return storage;
    }
    const message = await serverError(response);
    s.stop("The server could not write to the bucket", 1);
    p.log.error(wrapLog(message), io);
    const next = await ask.select(
      {
        message: "What now?",
        options: [
          { value: "keys" as const, label: "Re-enter the keys" },
          { value: "cancel" as const, label: "Cancel" },
        ],
      },
      undefined,
    );
    if (next === "cancel") throw new WizardCancelled();
  }
}

export async function runServerWizard(
  cfg: Config,
  input: ServerWizardInput = {},
  io: p.PromptIO = {},
  fetchImpl: FetchLike = fetch,
): Promise<BucketWizardResult | null> {
  try {
    return await wizard(cfg, input, io, fetchImpl);
  } catch (err) {
    if (err instanceof WizardCancelled) return null;
    throw err;
  }
}

async function wizard(
  cfg: Config,
  input: ServerWizardInput,
  io: p.PromptIO,
  fetchImpl: FetchLike,
): Promise<BucketWizardResult> {
  const ask = asker(input.yes ?? false, io);
  logger.info("sources", "server wizard started");
  const s = p.spinner(io);

  p.log.message(
    wrapLog(
      "A sessiondb server holds your bucket and its keys; this machine only gets a token. Your admin creates the token on the server (see sessiondb's docs/server.md).",
    ),
    io,
  );

  // --- which server, which token -----------------------------------------------
  let url: string | undefined;
  let token: string | undefined;
  let me: ServerIdentity | undefined;
  for (;;) {
    url ??= normalizeServerUrl(
      await ask.text(
        {
          message: "Server URL",
          placeholder: "https://sessions.example.com",
          validate: (value) => (normalizeServerUrl(value) ? undefined : "An http(s):// URL"),
        },
        input.server,
      ),
    );
    if (!url) throw new CliUsageError(`not a server URL: ${input.server}`);
    token ??= (
      await ask.text(
        {
          message: "Token",
          placeholder: "sdb_…",
          mask: true,
          validate: required("The token"),
        },
        input.token,
      )
    ).trim();
    s.start(`Checking ${url}...`);
    const answer = await identity(fetchImpl, url, token);
    if ("error" in answer) {
      s.stop(answer.unauthorized ? "Token not accepted" : "Server not reachable", 1);
      if (input.yes) throw new CliUsageError(answer.error);
      p.log.error(wrapLog(answer.error), io);
      const next = await ask.select(
        {
          message: "What now?",
          options: [
            ...(answer.unauthorized
              ? [{ value: "token" as const, label: "Re-enter the token" }]
              : [{ value: "retry" as const, label: "Try again" }]),
            { value: "url" as const, label: "Change the server URL" },
            { value: "cancel" as const, label: "Cancel" },
          ],
        },
        undefined,
      );
      if (next === "cancel") throw new WizardCancelled();
      if (next === "token") token = undefined;
      if (next === "url") {
        url = undefined;
        token = undefined;
      }
      continue;
    }
    me = answer;
    s.stop(`${url} knows this token as owner ${me.owner}`);
    break;
  }

  // --- the bucket behind it -----------------------------------------------------
  let storage = me.storage;
  if (!storage) {
    p.log.warn(
      wrapLog(
        `The server has no bucket linked for ${me.owner} yet, so it cannot store sessions until one is.`,
      ),
      io,
    );
    const link = await ask.confirm(
      {
        message: "Link a bucket on the server now?",
        active: "Yes, enter the bucket and its write keys",
        inactive: "Not now",
        initialValue: true,
      },
      input.yes ? false : undefined,
    );
    if (link) storage = await linkBucket(ask, fetchImpl, url, token, io, s);
  } else {
    p.log.info(wrapLog(`The server writes ${me.owner}'s sessions to ${storage.url}.`), io);
  }

  // --- save the target; ship there by default ---------------------------------
  const name = (
    await ask.text(
      {
        message: "Name for this target",
        initialValue: input.name ?? "server",
        validate: (value) =>
          /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(value) ? undefined : "letters, digits, . _ -",
      },
      input.name,
    )
  ).trim();
  const target: BucketTarget = { name, url, owner: me.owner, token };
  const existing = configuredTargets(cfg).find((t) => t.name === name);
  if (existing?.source_id) target.source_id = existing.source_id;
  cfg.targets = [...configuredTargets(cfg).filter((t) => t.name !== name), target];
  const makeDefault = await ask.confirm(
    {
      message: "Ship finished sessions through the server instead of to Dosu?",
      active: "Yes, the server",
      inactive: "No, keep Dosu",
      initialValue: true,
    },
    input.makeDefault,
  );
  if (makeDefault) cfg.default_target = name;
  saveConfig(cfg);
  p.log.success(
    wrapLog(
      makeDefault
        ? `Saved target "${name}": ${info("dosu sync")} uploads finished sessions to ${url}.`
        : `Saved target "${name}": ${info(`dosu sync --target ${name}`)} uploads there.`,
    ),
    io,
  );

  // --- let Dosu read the server's bucket -----------------------------------------
  if (!storage) {
    p.log.info(
      wrapLog(
        `Once a bucket is linked on the server, ${info(`dosu sources connect --target ${name}`)} lets Dosu read it.`,
      ),
      io,
    );
    return { target };
  }
  const parsed = bucketOfStorage(storage);
  if (!parsed) {
    p.log.info(
      wrapLog(`${storage.url} is a folder on the server, which Dosu cannot read; archive only.`),
      io,
    );
    return { target };
  }
  const api = sourcesApi(cfg);
  let dosuUnavailable: string | undefined;
  if (api && input.connect !== false) {
    s.start(`Checking Dosu at ${api.backendUrl}...`);
    dosuUnavailable = await preflight(api);
    s.stop(
      dosuUnavailable
        ? `Dosu at ${api.backendUrl} cannot connect buckets`
        : `Dosu at ${api.backendUrl} is ready`,
      dosuUnavailable ? 1 : 0,
    );
    if (dosuUnavailable) p.log.warn(wrapLog(dosuUnavailable), io);
  }
  return await connectBucketToDosu(
    cfg,
    api,
    {
      name,
      url: storage.url,
      ...parsed,
      owner: me.owner,
      region: storage.region,
      accountId: storage.account_id,
      endpoint: storage.endpoint,
    },
    { connect: input.connect, yes: input.yes ?? false, dosuUnavailable },
    ask,
    io,
    s,
  );
}
