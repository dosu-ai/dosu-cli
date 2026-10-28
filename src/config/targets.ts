/** Bucket / folder targets from `config.json`, and the one a command names: `--target team`
 * (a configured name), `--target s3://bucket/prefix` (an ad-hoc URL; its owner comes from
 * `--owner` or the `DOSU_OWNER` environment variable), or nothing (the default). Opening a store
 * is the only place the CLI touches `@dosu/sessionstorage`'s store classes. */

import { FsStore, type S3Credentials, S3Store, type Store } from "@dosu/sessionstorage";
import { RemoteStore } from "../store/remote";
import type { BucketTarget, Config } from "./schema";

/** `s3://`, `r2://`, `file://` or a bare path (a folder); `server` for a sessiondb server. */
type TargetScheme = "s3" | "r2" | "file" | "server";

function targetScheme(url: string): TargetScheme {
  if (url.startsWith("s3://")) return "s3";
  if (url.startsWith("r2://")) return "r2";
  if (/^https?:\/\//.test(url)) return "server";
  return "file";
}

/** A target that is a sessiondb server (the CLI uploads raw transcripts; the server writes the
 * bucket) rather than a bucket or folder written in-process. */
export function isServerTarget(target: Pick<BucketTarget, "url">): boolean {
  return targetScheme(target.url) === "server";
}

function isTargetUrl(value: string): boolean {
  return /^(s3|r2|file):\/\//.test(value) || value.startsWith("/") || value.startsWith(".");
}

export function configuredTargets(cfg: Config): BucketTarget[] {
  return cfg.targets ?? [];
}

function findTarget(cfg: Config, name: string): BucketTarget | undefined {
  return configuredTargets(cfg).find((target) => target.name === name);
}

/** A target named on the command line: a configured name, or a URL with its owner. Throws a
 * message fit for the terminal when neither resolves. */
export function resolveBucketTarget(
  cfg: Config,
  nameOrUrl: string,
  options: { owner?: string } = {},
): BucketTarget {
  const configured = findTarget(cfg, nameOrUrl);
  if (configured) return configured;
  if (!isTargetUrl(nameOrUrl)) {
    const names = configuredTargets(cfg).map((target) => target.name);
    throw new Error(
      `unknown target '${nameOrUrl}'${
        names.length > 0 ? ` (configured: ${names.join(", ")})` : " (no bucket targets configured)"
      }; pass a configured name or an s3://, r2:// or file:// URL`,
    );
  }
  const owner = options.owner ?? process.env.DOSU_OWNER;
  if (!owner) {
    throw new Error(
      `target ${nameOrUrl} needs an owner: pass --owner <name> or set DOSU_OWNER (the layout and dedupe are per owner)`,
    );
  }
  return { name: nameOrUrl, url: nameOrUrl, owner, credentials: "env" };
}

function staticCredentials(target: BucketTarget): S3Credentials | undefined {
  const credentials = target.credentials;
  if (!credentials || credentials === "env") return undefined;
  return {
    accessKeyId: credentials.access_key_id,
    secretAccessKey: credentials.secret_access_key,
    ...(credentials.session_token ? { sessionToken: credentials.session_token } : {}),
  };
}

/** The store behind a target. `S3Store` needs the Bun runtime (the CLI always has it). A server
 * target opens read-only: the library's readers work over its objects API, writes go through
 * the shipper. */
export function openStore(target: BucketTarget): Store & { url: string } {
  const scheme = targetScheme(target.url);
  if (scheme === "server") {
    if (!target.token) {
      throw new Error(`target ${target.name} (${target.url}) has no token; run 'dosu setup'`);
    }
    return new RemoteStore({ url: target.url, token: target.token });
  }
  if (scheme === "file") return new FsStore(target.url);
  return S3Store.fromUrl(target.url, {
    region: target.region,
    accountId: target.account_id,
    endpoint: target.endpoint,
    credentials: staticCredentials(target),
  });
}
