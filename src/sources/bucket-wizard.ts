/** The "ship straight to my bucket" flow, setup's storage step and `dosu sources setup
 * --bucket`. No server: `@dosu/sessiondb` redacts and normalizes each session on this machine
 * and writes it under `owners/<owner>/` with a key this machine holds. The flow checks the key
 * by writing the bucket's layout marker and the owner's probe, saves the target, and then asks
 * Dosu to read the bucket with its own read-only keys. */

import { userInfo } from "node:os";
import { CliUsageError } from "../cli/errors";
import { type Config, saveConfig } from "../config/config";
import type { BucketTarget } from "../config/schema";
import { configuredTargets } from "../config/targets";
import { logger } from "../debug/logger";
import { info, wrapLog } from "../setup/styles";
import { bucketClient } from "../shipper/target";
import * as p from "../tui/prompts";
import { sourcesApi } from "./api";
import { bucketOfStorage, type ConnectResult, connectBucketToDosu, preflight } from "./connect";
import {
  type Asker,
  asker,
  askKeyPair,
  envCredentials,
  type KeyPair,
  required,
  WizardCancelled,
} from "./prompts";
import { describeServerError } from "./server-client";

export interface BucketWizardResult extends ConnectResult {
  target: BucketTarget;
}

export interface BucketWizardInput {
  /** `s3://bucket/prefix` or `r2://bucket/prefix`. */
  bucket?: string;
  region?: string;
  accountId?: string;
  endpoint?: string;
  /** The key this machine writes with. */
  write?: KeyPair;
  /** The folder this machine's sessions go under (`owners/<owner>/`). */
  owner?: string;
  name?: string;
  /** Register the bucket with Dosu (needs the login). Default: yes when logged in. */
  connect?: boolean;
  /** Dosu's read keys, given up front. */
  read?: KeyPair;
  makeDefault?: boolean;
  yes?: boolean;
}

type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

const BUCKET_URL_RE = /^(s3|r2):\/\/[^/\s]+(?:\/\S*)?$/;
const OWNER_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;

/** `s3://bucket/prefix` without a trailing slash, or undefined when it is not a bucket URL. */
export function normalizeBucketUrl(value: string): string | undefined {
  const url = value.trim().replace(/\/+$/, "");
  return BUCKET_URL_RE.test(url) ? url : undefined;
}

const BUCKET_NAME_RE = /^[^/\s:]+(?:\/\S*)?$/;

/** `bucket[/prefix]` typed after picking `scheme`, as that scheme's URL; the scheme's own
 * `s3://`/`r2://` pasted in front is dropped. Undefined when it is not a bucket name. */
export function bucketUrlOf(scheme: "s3" | "r2", value: string): string | undefined {
  const name = value.trim().replace(new RegExp(`^${scheme}://`), "");
  return BUCKET_NAME_RE.test(name) ? normalizeBucketUrl(`${scheme}://${name}`) : undefined;
}

/** The bucket as a URL: which service it is on, then its name and prefix. A URL given up front
 * (a flag, or the org's store) is returned as is. */
export async function askBucketUrl(
  ask: Asker,
  given: string | undefined,
  what = "Bucket",
): Promise<string> {
  if (given !== undefined) return given;
  const scheme = await ask.select(
    {
      message: `${what}: which service?`,
      options: [
        { value: "s3" as const, label: "Amazon S3", hint: "or S3-compatible: MinIO, RustFS…" },
        { value: "r2" as const, label: "Cloudflare R2" },
      ],
    },
    undefined,
  );
  const name = await ask.text(
    {
      message: `${what}: name`,
      placeholder: "my-bucket, or my-bucket/sessions for a prefix",
      validate: (value) => (bucketUrlOf(scheme, value) ? undefined : "bucket[/prefix]"),
    },
    undefined,
  );
  const url = bucketUrlOf(scheme, name);
  if (!url) throw new CliUsageError(`not a bucket name: ${name}`);
  return url;
}

/** This machine's user name as an owner: one path segment of letters, digits, `.`, `_`, `-`. */
export function defaultOwner(): string {
  let name = "me";
  try {
    name = userInfo().username;
  } catch {
    // no passwd entry (a container); keep the fallback
  }
  const cleaned = name.replace(/[^A-Za-z0-9._-]+/g, "-").replace(/^[^A-Za-z0-9]+/, "");
  return cleaned.slice(0, 128) || "me";
}

/** Write the layout marker and the owner's probe with these keys: a wrong bucket, region or
 * key fails here, with the bucket's own error, rather than at the first session. */
async function checkWrite(
  target: BucketTarget,
  fetchImpl?: FetchLike,
): Promise<string | undefined> {
  const db = bucketClient({
    url: target.url,
    owner: target.owner,
    region: target.region,
    accountId: target.account_id,
    endpoint: target.endpoint,
    credentials: {
      accessKeyId: target.access_key_id,
      secretAccessKey: target.secret_access_key,
      sessionToken: target.session_token,
    },
    ...(fetchImpl ? { fetchImpl } : {}),
  });
  try {
    await db.check();
    return undefined;
  } catch (err) {
    // The bucket's own answer is the innermost cause: StoreError > write error > S3HttpError.
    const causes: string[] = [];
    for (let e = err as Error; e.cause instanceof Error; e = e.cause) causes.push(e.cause.message);
    return [describeServerError(err), ...causes.slice(-1)].join(": ");
  }
}

export async function runBucketWizard(
  cfg: Config,
  input: BucketWizardInput = {},
  io: p.PromptIO = {},
  fetchImpl?: FetchLike,
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
  input: BucketWizardInput,
  io: p.PromptIO,
  fetchImpl: FetchLike | undefined,
): Promise<BucketWizardResult> {
  const ask = asker(input.yes ?? false, io);
  logger.info("sources", "bucket wizard started");
  const s = p.spinner(io);

  p.log.message(
    wrapLog(
      "Sessions are redacted and normalized on this machine, then written to your bucket with a key this machine keeps (in its 0600 config). No server is involved. Scope the key to this person's folder, <prefix>/owners/<owner>/, by bucket policy.",
    ),
    io,
  );

  // --- the bucket, and how to reach it -----------------------------------------
  let url: string | undefined;
  let region: string | undefined;
  let accountId: string | undefined;
  let endpoint: string | undefined;
  let write: KeyPair | undefined = input.write;
  let owner: string | undefined;
  for (;;) {
    url ??= normalizeBucketUrl(await askBucketUrl(ask, input.bucket));
    if (!url) throw new CliUsageError(`not a bucket URL: ${input.bucket}`);
    const r2 = url.startsWith("r2://");

    if (r2) {
      endpoint ??= input.endpoint;
      if (!endpoint) {
        accountId ??= (
          await ask.text(
            {
              message: "Cloudflare account id",
              initialValue: process.env.R2_ACCOUNT_ID,
              validate: required("The account id"),
            },
            input.accountId,
          )
        ).trim();
      }
    } else {
      region ??= (
        await ask.text(
          {
            message: "AWS region",
            initialValue: process.env.AWS_REGION ?? "us-east-1",
            validate: required("The region"),
          },
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
          input.endpoint,
        )
      ).trim();
    }

    write ??=
      envCredentials("DOSU_BUCKET") ??
      (await askKeyPair(ask, "Write keys (this machine)", undefined));

    owner ??= (
      await ask.text(
        {
          message: "Your folder in the bucket (owner)",
          initialValue: defaultOwner(),
          validate: (value) =>
            OWNER_RE.test(value.trim()) ? undefined : "letters, digits, . _ - (one path segment)",
        },
        input.owner,
      )
    ).trim();
    if (!OWNER_RE.test(owner)) throw new CliUsageError(`not an owner name: ${owner}`);

    const candidate: BucketTarget = {
      kind: "bucket",
      name: "",
      url,
      owner,
      ...(region ? { region } : {}),
      ...(accountId ? { account_id: accountId } : {}),
      ...(endpoint ? { endpoint } : {}),
      access_key_id: write.access_key_id,
      secret_access_key: write.secret_access_key,
      session_token: write.session_token,
    };
    s.start(`Checking ${url}...`);
    const failure = await checkWrite(candidate, fetchImpl);
    if (failure) {
      s.stop("The bucket did not take a write", 1);
      if (input.yes) throw new CliUsageError(`${url}: ${failure}`);
      p.log.error(wrapLog(`${url}: ${failure}`), io);
      const next = await ask.select(
        {
          message: "What now?",
          options: [
            { value: "keys" as const, label: "Re-enter the write keys" },
            { value: "bucket" as const, label: "Change the bucket" },
            { value: "retry" as const, label: "Try again" },
            { value: "cancel" as const, label: "Cancel" },
          ],
        },
        undefined,
      );
      if (next === "cancel") throw new WizardCancelled();
      if (next === "keys") write = undefined;
      if (next === "bucket") {
        url = region = accountId = endpoint = undefined;
        input = {
          ...input,
          bucket: undefined,
          region: undefined,
          accountId: undefined,
          endpoint: undefined,
        };
      }
      continue;
    }
    s.stop(`${url} takes writes for ${owner}`);
    break;
  }

  // --- save the target; ship there by default ---------------------------------
  const name = (
    await ask.text(
      {
        message: "Name for this target",
        initialValue: input.name ?? "bucket",
        validate: (value) =>
          /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(value) ? undefined : "letters, digits, . _ -",
      },
      input.name,
    )
  ).trim();
  const target: BucketTarget = {
    kind: "bucket",
    name,
    url,
    owner,
    ...(region ? { region } : {}),
    ...(accountId ? { account_id: accountId } : {}),
    ...(endpoint ? { endpoint } : {}),
    access_key_id: write.access_key_id,
    secret_access_key: write.secret_access_key,
    session_token: write.session_token,
  };
  const existing = configuredTargets(cfg).find((t) => t.name === name);
  if (existing?.source_id) target.source_id = existing.source_id;
  cfg.targets = [...configuredTargets(cfg).filter((t) => t.name !== name), target];
  const others = configuredTargets(cfg).filter((t) => t.name !== name);
  const makeDefault =
    others.length === 0
      ? true
      : await ask.confirm(
          {
            message: "Ship finished sessions here by default?",
            active: `Yes, ${name}`,
            inactive: "No, keep the current default",
            initialValue: true,
          },
          input.makeDefault,
        );
  if (makeDefault) cfg.default_target = name;
  saveConfig(cfg);
  p.log.success(
    wrapLog(
      makeDefault
        ? `Saved target "${name}": ${info("dosu sync")} writes finished sessions to ${url}.`
        : `Saved target "${name}": ${info(`dosu sync --target ${name}`)} writes there.`,
    ),
    io,
  );

  // --- let Dosu read the bucket ------------------------------------------------
  // The URL matched BUCKET_URL_RE, which bucketOfStorage parses.
  const parsed = bucketOfStorage({ url, ...(endpoint ? { endpoint } : {}) }) as NonNullable<
    ReturnType<typeof bucketOfStorage>
  >;
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
  const connected = await connectBucketToDosu(
    cfg,
    api,
    { name, url, ...parsed, owner, region, accountId, endpoint },
    { read: input.read, connect: input.connect, yes: input.yes ?? false, dosuUnavailable },
    ask,
    io,
    s,
  );
  return { target, ...connected };
}
