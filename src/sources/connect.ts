/** The second half of setting up a server: ask Dosu to read the bucket the server writes.
 * Dosu gets its own read-only keys (checked by the backend when the source is registered),
 * reads new sessions on a schedule, and keeps only what it learns; the target in config gets
 * the source id so `dosu sync` can nudge a read after shipping. */

import { type Config, saveConfig } from "../config/config";
import { configuredTargets } from "../config/targets";
import { info, wrapLog } from "../setup/styles";
import * as p from "../tui/prompts";
import {
  type ConnectSourceRequest,
  type SourceStatus,
  type SourcesApi,
  SourcesApiError,
} from "./api";
import { type Asker, askKeyPair, envCredentials, type KeyPair } from "./prompts";
import type { LinkedStorage } from "./server-client";

export type BucketProvider = "s3" | "r2" | "compatible";

/** A bucket as Dosu is told about it: what the server reports it writes to. */
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

/** `r2://bucket/prefix` → what Dosu's connect call needs; a plain `s3://` with an endpoint is
 * S3-compatible. `file://` cannot be connected (Dosu cannot read a folder on the server). */
export function bucketOfStorage(
  storage: LinkedStorage,
): { provider: BucketProvider; bucket: string; prefix: string } | undefined {
  const m = /^(s3|r2):\/\/([^/]+)(?:\/(.*))?$/.exec(storage.url);
  if (!m) return undefined;
  const provider: BucketProvider = m[1] === "r2" ? "r2" : storage.endpoint ? "compatible" : "s3";
  return { provider, bucket: m[2] as string, prefix: (m[3] ?? "").replace(/^\/+|\/+$/g, "") };
}

export interface ConnectResult {
  /** The registered source, when the bucket was connected to Dosu. */
  source?: SourceStatus;
  /** Why the bucket was not connected although it was asked for (the target is saved). */
  connectError?: string;
}

export interface ConnectOptions {
  /** Dosu's read keys, given up front. */
  read?: KeyPair;
  connect?: boolean;
  yes: boolean;
  /** Why Dosu cannot be asked right now (the preflight's answer), if it cannot. */
  dosuUnavailable?: string;
}

/** Ask which keys Dosu reads with, register the source, and retry or skip on failure. The
 * target is saved before this runs, so every exit here leaves it usable. */
export async function connectBucketToDosu(
  cfg: Config,
  api: SourcesApi | undefined,
  target: ConnectableBucket,
  options: ConnectOptions,
  ask: Asker,
  io: p.PromptIO,
  s: ReturnType<typeof p.spinner>,
): Promise<ConnectResult> {
  const { name, url, provider, bucket, prefix, owner, region, accountId, endpoint } = target;
  const input = { read: options.read, connect: options.connect, yes: options.yes };
  const dosuUnavailable = options.dosuUnavailable;
  if (!api) {
    p.log.info(
      wrapLog(
        `Not logged in to Dosu, so the bucket stays an archive for now. After ${info("dosu setup")}, ${info(`dosu sources connect --target ${name}`)} lets Dosu learn from it.`,
      ),
      io,
    );
    return {};
  }
  if (dosuUnavailable) {
    p.log.info(
      wrapLog(
        `Archive for now. ${info(`dosu sources connect --target ${name}`)} connects it once Dosu is reachable.`,
      ),
      io,
    );
    return { connectError: dosuUnavailable };
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
    return {};
  }

  let read: KeyPair;
  if (input.read) {
    read = input.read;
  } else {
    const fromEnv = envCredentials("DOSU_SOURCE");
    if (fromEnv) {
      read = fromEnv;
    } else {
      p.log.info(
        wrapLog("Dosu needs a key pair limited to GetObject + ListBucket on the bucket."),
        io,
      );
      read = await askKeyPair(ask, "Read-only keys", undefined);
    }
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
        return { connectError: message };
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
        return { connectError: message };
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
  return { source };
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
