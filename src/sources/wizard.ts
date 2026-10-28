/** The interactive "keep my sessions in my own bucket" flow, shared by `dosu setup` and
 * `dosu sources setup`: which store (S3, R2, S3-compatible), where in it, who this machine
 * writes as, the keys it writes with (checked with a write-and-read-back probe), the keys Dosu
 * reads with (checked by the backend when the source is registered), then the target becomes
 * where `dosu sync` ships and Dosu is asked to read it right away.
 *
 * Every answer can be given up front (flags, `DOSU_SOURCE_*` / `AWS_*` / `R2_*` environment)
 * so the flow prompts only for what is missing, and not at all with `--yes`. */

import { ensureLayout, probe } from "@dosu/sessionstorage";
import { CliUsageError } from "../cli/errors";
import { type Config, saveConfig } from "../config/config";
import { getAccessTokenEmail } from "../config/identity";
import type { BucketCredentials, BucketTarget } from "../config/schema";
import { configuredTargets, openStore } from "../config/targets";
import { logger } from "../debug/logger";
import { info, wrapLog } from "../setup/styles";
import * as p from "../tui/prompts";
import { VERSION } from "../version/version";
import {
  type ConnectSourceRequest,
  type SourceStatus,
  type SourcesApi,
  SourcesApiError,
  sourcesApi,
} from "./api";

export type BucketProvider = "s3" | "r2" | "compatible";

/** Answers given before the prompts run; anything missing is asked for. */
export interface BucketWizardInput {
  provider?: BucketProvider;
  bucket?: string;
  prefix?: string;
  owner?: string;
  region?: string;
  accountId?: string;
  endpoint?: string;
  /** How the target is named in config and on the command line. */
  name?: string;
  /** The keys this machine writes with; `"env"` means the ambient AWS / R2 environment. */
  write?: "env" | BucketCredentials;
  /** The keys Dosu reads with; `"same"` reuses the write keys (they must then be static). */
  read?: "same" | BucketCredentials;
  /** Register the bucket with Dosu (needs the login). Default: yes when logged in. */
  connect?: boolean;
  /** Make it where `dosu sync` ships. Default: yes. */
  makeDefault?: boolean;
  /** Never prompt: a missing answer is an error. */
  yes?: boolean;
}

export interface BucketWizardResult {
  target: BucketTarget;
  /** The registered source, when the bucket was connected to Dosu. */
  source?: SourceStatus;
  /** Why the bucket was not connected although it was asked for (the target is saved). */
  connectError?: string;
}

export const PROVIDERS: readonly p.SelectOption<BucketProvider>[] = [
  { value: "s3", label: "Amazon S3", hint: "an S3 bucket in your AWS account" },
  { value: "r2", label: "Cloudflare R2", hint: "an R2 bucket in your Cloudflare account" },
  {
    value: "compatible",
    label: "S3-compatible",
    hint: "MinIO, RustFS, Backblaze B2, Wasabi… anything with an S3 endpoint",
  },
];

const OWNER_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;

export function required(label: string): (value: string) => string | undefined {
  return (value) => (value.trim() ? undefined : `${label} is required`);
}

/** The default owner: the login's email (sessions are per person), else the OS user. */
export function defaultOwner(cfg: Config): string | undefined {
  const token = cfg.active_account?.session.access_token;
  const email = token ? getAccessTokenEmail(token) : undefined;
  const candidate = email ?? process.env.USER ?? process.env.USERNAME;
  if (!candidate) return undefined;
  const owner = candidate
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, "-")
    .replace(/^-+/, "");
  return OWNER_RE.test(owner) ? owner : undefined;
}

/** The `--provider` a URL or an environment implies. */
export function inferProvider(input: BucketWizardInput): BucketProvider | undefined {
  if (input.provider) return input.provider;
  if (input.endpoint) return "compatible";
  if (input.accountId || process.env.R2_ACCOUNT_ID) return "r2";
  if (input.region) return "s3";
  return undefined;
}

/** `s3://bucket/prefix` for S3 and S3-compatible stores, `r2://bucket/prefix` for R2. */
export function targetUrl(provider: BucketProvider, bucket: string, prefix: string): string {
  const scheme = provider === "r2" ? "r2" : "s3";
  const path = prefix.replace(/^\/+|\/+$/g, "");
  return path ? `${scheme}://${bucket}/${path}` : `${scheme}://${bucket}`;
}

/** Static keys from the ambient environment, when it has a full pair. */
function envCredentials(prefix: "AWS" | "R2" | "DOSU_SOURCE"): BucketCredentials | undefined {
  const id = process.env[`${prefix}_ACCESS_KEY_ID`];
  const secret = process.env[`${prefix}_SECRET_ACCESS_KEY`];
  if (!id || !secret) return undefined;
  const token = process.env[`${prefix}_SESSION_TOKEN`];
  return {
    access_key_id: id,
    secret_access_key: secret,
    ...(token ? { session_token: token } : {}),
  };
}

export class WizardCancelled extends Error {
  constructor() {
    super("cancelled");
    this.name = "WizardCancelled";
  }
}

function unwrap<T>(value: T | symbol): T {
  if (p.isCancel(value)) throw new WizardCancelled();
  return value as T;
}

export interface Asker {
  text(opts: Parameters<typeof p.text>[0], given: string | undefined): Promise<string>;
  select<T>(opts: Parameters<typeof p.select<T>>[0], given: T | undefined): Promise<T>;
  confirm(opts: Parameters<typeof p.confirm>[0], given: boolean | undefined): Promise<boolean>;
}

/** Prompts that take a given answer first, and under `--yes` refuse to ask at all. */
export function asker(yes: boolean, io: p.PromptIO): Asker {
  const missing = (what: string): never => {
    throw new CliUsageError(`--yes: ${what} was not given (pass it as a flag or environment)`);
  };
  return {
    async text(opts, given) {
      if (given !== undefined) return given;
      if (opts.initialValue !== undefined && yes) return opts.initialValue;
      if (yes) return missing(opts.message);
      return unwrap(await p.text(opts, io));
    },
    async select(opts, given) {
      if (given !== undefined) return given;
      if (yes) return missing(opts.message);
      return unwrap(await p.select(opts, io));
    },
    async confirm(opts, given) {
      if (given !== undefined) return given;
      if (yes) return opts.initialValue ?? true;
      return unwrap(await p.confirm(opts, io));
    },
  };
}

export async function askKeyPair(
  ask: Asker,
  what: string,
  given: BucketCredentials | undefined,
): Promise<BucketCredentials> {
  if (given) return given;
  const access_key_id = await ask.text(
    { message: `${what}: access key id`, validate: required("The access key id") },
    undefined,
  );
  const secret_access_key = await ask.text(
    { message: `${what}: secret access key`, mask: true, validate: required("The secret") },
    undefined,
  );
  return { access_key_id, secret_access_key };
}

/** The keys this machine uploads with: the ambient environment or an entered pair. */
async function askWriteKeys(
  ask: Asker,
  provider: BucketProvider,
): Promise<"env" | BucketCredentials> {
  const ambient = provider === "r2" ? envCredentials("R2") : envCredentials("AWS");
  const profile = provider !== "r2" ? process.env.AWS_PROFILE : undefined;
  const useEnv = {
    value: "env" as const,
    label: "Use my environment",
    hint:
      ambient || profile
        ? ambient
          ? `${provider === "r2" ? "R2" : "AWS"}_ACCESS_KEY_ID is set`
          : `AWS_PROFILE=${profile}`
        : `${provider === "r2" ? "R2_*" : "AWS_* variables or an AWS profile"} at upload time`,
  };
  const enter = {
    value: "enter" as const,
    label: "Enter an access key pair",
    hint: "saved to the CLI config (0600)",
  };
  const choice = await ask.select(
    {
      message: "Keys this machine uploads with",
      options: ambient || profile ? [useEnv, enter] : [enter, useEnv],
    },
    undefined,
  );
  return choice === "env" ? "env" : askKeyPair(ask, "Upload keys", undefined);
}

/** Earlier answers offered as defaults when the flow starts over after a failed check. */
interface Seed {
  bucket?: string;
  prefix?: string;
  owner?: string;
  region?: string;
  accountId?: string;
  endpoint?: string;
}

/** Run the flow. Returns null when the user cancelled; throws `CliUsageError` for an answer
 * that cannot work. The target is saved to config before Dosu is contacted, so a connect
 * failure leaves something `dosu sources connect` can finish later. */
export async function runBucketWizard(
  cfg: Config,
  input: BucketWizardInput = {},
  io: p.PromptIO = {},
): Promise<BucketWizardResult | null> {
  try {
    return await wizard(cfg, input, io, {});
  } catch (err) {
    if (err instanceof WizardCancelled) return null;
    throw err;
  }
}

async function wizard(
  cfg: Config,
  input: BucketWizardInput,
  io: p.PromptIO,
  seed: Seed,
): Promise<BucketWizardResult> {
  const ask = asker(input.yes ?? false, io);
  logger.info("sources", "bucket wizard started");
  const s = p.spinner(io);

  // --- can Dosu be asked at all? Found out first, not after every bucket question. --------
  const api = sourcesApi(cfg);
  let dosuUnavailable: string | undefined;
  if (api && input.connect !== false) {
    s.start(`Checking Dosu at ${api.backendUrl}...`);
    dosuUnavailable = await preflight(api);
    if (dosuUnavailable) {
      s.stop(`Dosu at ${api.backendUrl} cannot connect buckets`, 1);
      p.log.warn(
        wrapLog(
          `${dosuUnavailable}\nThe bucket can still be set up as where ${info("dosu sync")} ships; ${info("dosu sources connect")} lets Dosu read it once that is fixed.`,
        ),
        io,
      );
      if (!input.yes) {
        const next = await ask.select(
          {
            message: "What now?",
            options: [
              { value: "continue" as const, label: "Set up the bucket anyway" },
              { value: "cancel" as const, label: "Cancel" },
            ],
          },
          undefined,
        );
        if (next === "cancel") throw new WizardCancelled();
      }
    } else {
      s.stop(`Dosu at ${api.backendUrl} is ready`);
    }
  }

  // --- where ---------------------------------------------------------------
  const provider = await ask.select(
    { message: "Where do you keep your sessions?", options: PROVIDERS },
    inferProvider(input),
  );
  const bucket = (
    await ask.text(
      {
        message: "Bucket name",
        placeholder: "my-agent-sessions",
        initialValue: seed.bucket,
        validate: required("The bucket"),
      },
      input.bucket,
    )
  ).trim();
  const prefix = (
    await ask.text(
      {
        message: "Prefix inside the bucket",
        initialValue: input.prefix ?? seed.prefix ?? "dosu",
        validate: (value) => (/^[^\s]*$/.test(value) ? undefined : "No spaces in a prefix"),
      },
      input.prefix,
    )
  ).trim();

  let region: string | undefined;
  let accountId: string | undefined;
  let endpoint: string | undefined;
  if (provider === "s3") {
    region = (
      await ask.text(
        {
          message: "AWS region",
          initialValue:
            input.region ??
            seed.region ??
            process.env.AWS_REGION ??
            process.env.AWS_DEFAULT_REGION ??
            "us-east-1",
          validate: required("The region"),
        },
        input.region,
      )
    ).trim();
  } else if (provider === "r2") {
    accountId = (
      await ask.text(
        {
          message: "Cloudflare account id",
          placeholder: "32 hex characters, from the R2 dashboard",
          initialValue: input.accountId ?? seed.accountId ?? process.env.R2_ACCOUNT_ID,
          validate: (value) =>
            /^[0-9a-f]{32}$/i.test(value.trim()) ? undefined : "An account id is 32 hex characters",
        },
        input.accountId,
      )
    ).trim();
  } else {
    endpoint = (
      await ask.text(
        {
          message: "S3 endpoint URL",
          placeholder: "https://s3.example.com or http://localhost:9000",
          initialValue:
            input.endpoint ??
            seed.endpoint ??
            process.env.AWS_ENDPOINT_URL_S3 ??
            process.env.AWS_ENDPOINT_URL,
          validate: (value) =>
            /^https?:\/\/\S+$/.test(value.trim()) ? undefined : "An http(s):// URL",
        },
        input.endpoint,
      )
    ).trim();
    region = input.region ?? process.env.AWS_REGION ?? "auto";
  }

  const owner = (
    await ask.text(
      {
        message: "Owner id (your sessions land under owners/<id>/)",
        initialValue: input.owner ?? seed.owner ?? defaultOwner(cfg),
        validate: (value) =>
          OWNER_RE.test(value.trim()) ? undefined : "Letters, digits, '.', '_' and '-' only",
      },
      input.owner,
    )
  ).trim();

  const url = targetUrl(provider, bucket, prefix);
  const name = (input.name ?? (provider === "r2" ? "r2" : provider === "s3" ? "s3" : bucket))
    .trim()
    .replace(/[^A-Za-z0-9._-]+/g, "-");
  const taken = configuredTargets(cfg).find((t) => t.name === name && t.url !== url);
  if (taken) {
    throw new CliUsageError(
      `a target named '${name}' already points at ${taken.url}: pass --name <other>`,
    );
  }

  // --- the keys this machine writes with --------------------------------------
  let write = input.write ?? (await askWriteKeys(ask, provider));

  // --- can this machine write there? A failure is something to fix, not the end: re-enter
  // the keys, try again, or start over with the other answers kept. ------------------------
  let target: BucketTarget;
  for (;;) {
    target = {
      name,
      url,
      owner,
      ...(region ? { region } : {}),
      ...(accountId ? { account_id: accountId } : {}),
      ...(endpoint ? { endpoint } : {}),
      credentials: write,
    };
    s.start(`Checking ${url} (owner ${owner})...`);
    try {
      const store = openStore(target);
      const marker = await ensureLayout(store, `dosu-cli/${VERSION}`);
      await probe(store, owner);
      s.stop(
        `${url} is writable${marker.created_by === `dosu-cli/${VERSION}` ? "" : ` (layout by ${marker.created_by})`}`,
      );
      break;
    } catch (err) {
      s.stop(`Could not write to ${url}`, 1);
      const message = err instanceof Error ? err.message : String(err);
      const hint = `Check the bucket name, ${
        provider === "s3" ? "region" : provider === "r2" ? "account id" : "endpoint"
      } and keys (the policy needs PutObject and GetObject under ${prefix ? `${prefix}/` : "the bucket root"}).`;
      if (input.yes) {
        throw new CliUsageError(`${message}\n${hint} Then run 'dosu sources setup' again.`);
      }
      p.log.error(wrapLog(`${message}\n${hint}`), io);
      const next = await ask.select(
        {
          message: "What now?",
          options: [
            { value: "keys" as const, label: "Re-enter the keys" },
            { value: "retry" as const, label: "Try again", hint: "same details" },
            {
              value: "restart" as const,
              label: "Start over",
              hint: "change the bucket, prefix, account or owner; answers are kept as defaults",
            },
            { value: "cancel" as const, label: "Cancel" },
          ],
        },
        undefined,
      );
      if (next === "cancel") throw new WizardCancelled();
      if (next === "restart") {
        return wizard(cfg, { ...input, write }, io, {
          bucket,
          prefix,
          owner,
          region,
          accountId,
          endpoint,
        });
      }
      if (next === "keys") write = await askWriteKeys(ask, provider);
    }
  }

  // --- save the target; ship there by default ---------------------------------
  const targets = configuredTargets(cfg).filter((t) => t.name !== name);
  targets.push(target);
  cfg.targets = targets;
  const makeDefault = await ask.confirm(
    {
      message: "Ship finished sessions there instead of to Dosu?",
      active: "Yes, my bucket",
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
        ? `Saved target "${name}": ${info("dosu sync")} ships finished sessions to ${url}.`
        : `Saved target "${name}": ${info(`dosu sync --target ${name}`)} ships there.`,
    ),
    io,
  );

  // --- let Dosu read it ---------------------------------------------------------
  return await connectBucketToDosu(
    cfg,
    api,
    { name, url, provider, bucket, prefix, owner, region, accountId, endpoint },
    {
      write: write !== "env" ? write : undefined,
      read: input.read,
      connect: input.connect,
      yes: input.yes ?? false,
      dosuUnavailable,
    },
    ask,
    io,
    s,
  );
}

/** A bucket as Dosu is told about it: what the wizard set up, or what a sessiondb server
 * reports it writes to. */
export interface ConnectableBucket {
  name: string;
  url: string;
  provider: BucketProvider;
  bucket: string;
  prefix: string;
  owner: string;
  region?: string;
  accountId?: string;
  endpoint?: string;
}

export interface ConnectOptions {
  /** This machine's static write keys, offered as "the same keys" for Dosu to read with. */
  write?: BucketCredentials;
  read?: BucketWizardInput["read"];
  connect?: boolean;
  yes: boolean;
  /** Why Dosu cannot be asked right now (the preflight's answer), if it cannot. */
  dosuUnavailable?: string;
}

/** The second half of setting up a bucket: ask Dosu to read it. Asks which keys Dosu reads
 * with, registers the source, and retries or skips on failure; the target in config gets the
 * source id. The target is saved before this runs, so every exit here leaves it usable. */
export async function connectBucketToDosu(
  cfg: Config,
  api: SourcesApi | undefined,
  target: ConnectableBucket,
  options: ConnectOptions,
  ask: Asker,
  io: p.PromptIO,
  s: ReturnType<typeof p.spinner>,
): Promise<BucketWizardResult> {
  const { name, url, provider, bucket, prefix, owner, region, accountId, endpoint } = target;
  const saved = configuredTargets(cfg).find((t) => t.name === name) as BucketTarget;
  const write = options.write;
  const input = { read: options.read, connect: options.connect, yes: options.yes };
  const dosuUnavailable = options.dosuUnavailable;
  if (!api) {
    p.log.info(
      wrapLog(
        `Not logged in to Dosu, so the bucket stays an archive for now. After ${info("dosu setup")}, ${info(`dosu sources connect --target ${name}`)} lets Dosu learn from it.`,
      ),
      io,
    );
    return { target: saved };
  }
  if (dosuUnavailable) {
    p.log.info(
      wrapLog(
        `Archive for now. ${info(`dosu sources connect --target ${name}`)} connects it once Dosu is reachable.`,
      ),
      io,
    );
    return { target: saved, connectError: dosuUnavailable };
  }
  const connect = await ask.confirm(
    {
      message: "Let Dosu read the bucket and learn from the sessions in it?",
      active: "Yes, connect",
      inactive: "Not now",
      initialValue: true,
    },
    input.connect,
  );
  if (!connect) {
    p.log.info(
      wrapLog(`Archive only. ${info(`dosu sources connect --target ${name}`)} connects it later.`),
      io,
    );
    return { target: saved };
  }

  let read: BucketCredentials;
  if (input.read && input.read !== "same") {
    read = input.read;
  } else if (input.read === "same" || envCredentials("DOSU_SOURCE")) {
    read = envCredentials("DOSU_SOURCE") ?? requireStatic(write);
  } else {
    const staticWrite = write;
    const choice = await ask.select(
      {
        message: "Keys Dosu reads the bucket with",
        options: [
          ...(staticWrite
            ? [
                {
                  value: "same" as const,
                  label: "The same keys",
                  hint: "simplest; Dosu only reads",
                },
              ]
            : []),
          {
            value: "enter" as const,
            label: "A separate read-only key pair",
            hint: "recommended: a key limited to GetObject + ListBucket",
          },
        ],
      },
      undefined,
    );
    read =
      choice === "same" ? requireStatic(write) : await askKeyPair(ask, "Read-only keys", undefined);
  }

  // A failed connect is retried from here: again, with other keys for Dosu, or skipped (the
  // target is saved either way, so `dosu sources connect` can finish it later).
  let source: SourceStatus;
  for (;;) {
    const body: Omit<ConnectSourceRequest, "deployment_id"> = {
      kind: provider === "r2" ? "r2" : "s3",
      bucket,
      prefix,
      owner,
      ...(region ? { region } : {}),
      ...(accountId ? { account_id: accountId } : {}),
      ...(endpoint ? { endpoint } : {}),
      ...read,
      name,
    };
    s.start("Asking Dosu to read the bucket...");
    try {
      source = await api.connect(body);
      break;
    } catch (err) {
      const badKeys = err instanceof SourcesApiError && (err.status === 400 || err.status === 422);
      const message =
        err instanceof SourcesApiError
          ? badKeys
            ? `Dosu could not read ${url} as owner ${owner} with those keys: ${err.message}`
            : `Dosu did not accept the source: ${err.message}`
          : err instanceof Error
            ? err.message
            : String(err);
      s.stop("Dosu could not connect the bucket", 1);
      const later = `The target is saved; ${info(`dosu sources connect --target ${name}`)} tries again.`;
      if (input.yes) {
        p.log.warn(wrapLog(`${message}\n${later}`), io);
        return { target: saved, connectError: message };
      }
      p.log.error(wrapLog(message), io);
      const retry = { value: "retry" as const, label: "Try again" };
      const keys = { value: "keys" as const, label: "Give Dosu different keys" };
      const next = await p.select(
        {
          message: "What now?",
          options: [
            ...(badKeys ? [keys, retry] : [retry, keys]),
            {
              value: "skip" as const,
              label: "Skip for now",
              hint: `dosu sources connect --target ${name} finishes this later`,
            },
          ],
        },
        io,
      );
      // Cancelling here is skipping: the target is already saved, so this is not "nothing".
      if (p.isCancel(next) || next === "skip") {
        p.log.warn(wrapLog(later), io);
        return { target: saved, connectError: message };
      }
      if (next === "keys") read = await askKeyPair(ask, "Read-only keys", undefined);
    }
  }
  s.stop(`Dosu reads ${source.url} (source "${source.name}")`);
  const configured = configuredTargets(cfg).find((t) => t.name === name);
  if (configured) configured.source_id = source.id;
  saveConfig(cfg);
  p.log.info(
    wrapLog(
      `Dosu reads new sessions within a few minutes of each upload and keeps only what it learns; transcripts stay in your bucket. ${info("dosu sources status")} shows progress.`,
    ),
    io,
  );
  return { target: saved, source };
}

/** Why Dosu cannot connect a bucket right now, or undefined when it can: the sources API
 * answered. A 404 is a Dosu without the feature; anything else is reported as it came. */
export async function preflight(api: SourcesApi): Promise<string | undefined> {
  try {
    await api.list();
    return undefined;
  } catch (err) {
    if (err instanceof SourcesApiError) {
      return err.status === 404
        ? `Dosu at ${api.backendUrl} has no session sources API (HTTP 404): it is an older or different Dosu than this CLI expects.`
        : `Dosu at ${api.backendUrl} answered ${err.message}.`;
    }
    const message = err instanceof Error ? err.message : String(err);
    return `Could not reach Dosu at ${api.backendUrl}: ${message}`;
  }
}

function requireStatic(write: BucketCredentials | undefined): BucketCredentials {
  if (!write) {
    throw new CliUsageError(
      "Dosu cannot use this machine's environment: give it a key pair (--read-access-key-id/--read-secret-access-key, or DOSU_SOURCE_ACCESS_KEY_ID/DOSU_SOURCE_SECRET_ACCESS_KEY)",
    );
  }
  return { ...write };
}
