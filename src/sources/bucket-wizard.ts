/** A member's folder of the org's bucket store, written from this machine: what joining a bucket
 * store asks once the folder is claimed (`dosu setup`, `dosu sources store join`). No server:
 * `@dosu/sessiondb` redacts and normalizes each session on this machine and writes it under
 * `owners/<owner>/` with a write key this machine keeps, checked by writing the layout marker and
 * the owner's probe. Dosu reads the folder with the org's read-only key, which the member never
 * sees. The bucket is the org's, set by an org admin; nothing here connects a bucket to Dosu.
 *
 * Also the bucket URL questions the admin's store setup asks (`askBucketUrl`). */

import { userInfo } from "node:os";
import { CliUsageError } from "../cli/errors";
import { type Config, saveConfig } from "../config/config";
import type { BucketTarget } from "../config/schema";
import { configuredTargets } from "../config/targets";
import { logger } from "../debug/logger";
import { info, wrapLog } from "../setup/styles";
import { bucketClient } from "../shipper/target";
import * as p from "../tui/prompts";
import {
  type Asker,
  asker,
  askKeyPair,
  envCredentials,
  type KeyPair,
  WizardCancelled,
} from "./prompts";
import { describeServerError } from "./server-client";

export interface BucketWizardInput {
  /** The org's bucket, `s3://bucket/prefix` or `r2://bucket/prefix`. */
  bucket: string;
  region?: string;
  accountId?: string;
  endpoint?: string;
  /** The folder this machine's sessions go under (`owners/<owner>/`), claimed already. */
  owner: string;
  /** The key this machine writes with. */
  write?: KeyPair;
  name?: string;
  makeDefault?: boolean;
  yes?: boolean;
}

type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

const BUCKET_URL_RE = /^(s3|r2):\/\/[^/\s]+(?:\/\S*)?$/;

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

/** Save a bucket target for the member's folder, the default unless the person keeps another.
 * Null when the person cancelled. */
export async function runBucketWizard(
  cfg: Config,
  input: BucketWizardInput,
  io: p.PromptIO = {},
  fetchImpl?: FetchLike,
): Promise<{ target: BucketTarget } | null> {
  try {
    return { target: await writeTarget(cfg, asker(input.yes ?? false, io), input, io, fetchImpl) };
  } catch (err) {
    if (err instanceof WizardCancelled) return null;
    throw err;
  }
}

/** The write key this machine keeps, checked by writing the layout marker
 * (`sessionstorage.json`) and the folder's probe; then the target is saved. */
async function writeTarget(
  cfg: Config,
  ask: Asker,
  input: BucketWizardInput,
  io: p.PromptIO,
  fetchImpl: FetchLike | undefined,
): Promise<BucketTarget> {
  logger.info("sources", "bucket write key step started");
  const s = p.spinner(io);
  const url = normalizeBucketUrl(input.bucket);
  if (!url) throw new CliUsageError(`not a bucket URL: ${input.bucket}`);
  const { owner, region, accountId, endpoint } = input;
  p.log.message(
    wrapLog(
      `Sessions are redacted and normalized on this machine, then written under ${url}/owners/${owner}/ with a write key this machine keeps (in its 0600 config); Dosu reads them with the org's own read-only key. Anything written into the org's bucket reaches the org's memory, so this key can add to it: your admin scopes it to your folder by bucket policy.`,
    ),
    io,
  );
  let write: KeyPair | undefined = input.write;
  for (;;) {
    write ??=
      envCredentials("DOSU_BUCKET") ??
      (await askKeyPair(ask, "Write key (this machine)", undefined));
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
    if (!failure) {
      s.stop(`${url} takes writes for ${owner}`);
      break;
    }
    s.stop("The bucket did not take a write", 1);
    if (input.yes) throw new CliUsageError(`${url}: ${failure}`);
    p.log.error(wrapLog(`${url}: ${failure}`), io);
    const next = await ask.select(
      {
        message: "What now?",
        options: [
          { value: "keys" as const, label: "Re-enter the write key" },
          { value: "retry" as const, label: "Try again" },
          { value: "cancel" as const, label: "Cancel" },
        ],
      },
      undefined,
    );
    if (next === "cancel") throw new WizardCancelled();
    if (next === "keys") write = undefined;
  }

  const name = (
    await ask.text(
      {
        message: "Name for this target",
        initialValue: input.name ?? "org",
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
  return target;
}
