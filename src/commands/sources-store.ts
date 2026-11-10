/** `dosu sources store`: the org's session store. An org admin says once where the org keeps its
 * sessions and gives Dosu its read key (`setup`); each member's `dosu setup` then enrolls for
 * their own folder (`join` does it again by hand), and `status` shows the store and, to an admin,
 * who has enrolled. */

import { Command } from "commander";
import pc from "picocolors";
import { CliUsageError } from "../cli/errors";
import { loadConfig } from "../config/config";
import {
  requireStoreApi,
  type SessionStore,
  type SetStoreRequest,
  SourcesApiError,
  type StoreKind,
} from "../sources/api";
import { askBucketUrl, normalizeBucketUrl } from "../sources/bucket-wizard";
import { bucketOfStorage } from "../sources/connect";
import { asker, askKeyPair, envCredentials, type KeyPair, required } from "../sources/prompts";
import { normalizeServerUrl } from "../sources/server-wizard";
import { describeStore, joinOrgStore, orgStore } from "../sources/store";
import { formatAge, printResult, printTable } from "./output";

export function storeCommand(): Command {
  const cmd = new Command("store").description(
    "The org's session store: where everyone's sessions go, set once by an org admin",
  );
  cmd.addCommand(setupCommand());
  cmd.addCommand(statusCommand());
  cmd.addCommand(joinCommand());
  return cmd;
}

// --- setup (admin) -----------------------------------------------------------

interface StoreSetupOptions {
  hosted?: boolean;
  server?: string;
  bucket?: string;
  region?: string;
  accountId?: string;
  endpoint?: string;
  readAccessKeyId?: string;
  readSecretAccessKey?: string;
  tokenSecret?: string;
  clearTokenSecret?: boolean;
  yes?: boolean;
  json?: boolean;
}

/** The kind the flags name, or undefined when they name none (the wizard asks). */
function kindOf(opts: StoreSetupOptions): StoreKind | undefined {
  if (opts.hosted && (opts.server || opts.bucket)) {
    throw new CliUsageError("--hosted is Dosu's: --server and --bucket are for the org's own");
  }
  if (opts.hosted) return "hosted";
  if (opts.server) return "server";
  if (opts.bucket) return "bucket";
  return undefined;
}

/** What `PUT /v1/memory/store` is sent, from flags first and questions for the rest. */
async function storeRequest(
  opts: StoreSetupOptions,
  current: SessionStore | undefined,
): Promise<SetStoreRequest> {
  if (Boolean(opts.readAccessKeyId) !== Boolean(opts.readSecretAccessKey)) {
    throw new CliUsageError("--read-access-key-id and --read-secret-access-key go together");
  }
  if (opts.tokenSecret && opts.clearTokenSecret) {
    throw new CliUsageError("--token-secret and --clear-token-secret contradict");
  }
  const ask = asker(opts.yes ?? false, {});
  const kind =
    kindOf(opts) ??
    (await ask.select<StoreKind>(
      {
        message: "Where should the org's sessions go?",
        options: [
          { value: "hosted", label: "Dosu's sessiondb", hint: "nothing to run; Dosu stores them" },
          {
            value: "server",
            label: "Our sessiondb server",
            hint: "it redacts and writes our bucket; members ship to it",
          },
          {
            value: "bucket",
            label: "Our bucket (S3 / R2)",
            hint: "members redact on their machine and write it directly",
          },
        ],
      },
      undefined,
    ));
  if (kind === "hosted") {
    if (opts.tokenSecret || opts.clearTokenSecret) {
      throw new CliUsageError("the token secret is a server's: only a server store has one");
    }
    return { kind };
  }

  let serverUrl: string | undefined;
  if (kind === "server") {
    const given = await ask.text(
      {
        message: "Server URL",
        placeholder: "https://sessions.example.com",
        validate: (value) =>
          normalizeServerUrl(value) ? undefined : "An https:// URL (http:// only to localhost)",
      },
      opts.server,
    );
    serverUrl = normalizeServerUrl(given);
    if (!serverUrl) throw new CliUsageError(`not a server URL: ${given}`);
  }
  const givenBucket = await askBucketUrl(
    ask,
    opts.bucket,
    kind === "server" ? "The bucket the server writes" : "Bucket",
  );
  const url = normalizeBucketUrl(givenBucket);
  if (!url) throw new CliUsageError(`not a bucket URL: ${givenBucket}`);
  const r2 = url.startsWith("r2://");
  let region: string | undefined;
  let accountId: string | undefined;
  let endpoint = opts.endpoint;
  if (r2) {
    if (!endpoint) {
      accountId = (
        await ask.text(
          { message: "Cloudflare account id", validate: required("The account id") },
          opts.accountId,
        )
      ).trim();
    }
  } else {
    region = (
      await ask.text(
        { message: "AWS region", initialValue: "us-east-1", validate: required("The region") },
        opts.region,
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
  const read: KeyPair =
    (opts.readAccessKeyId && opts.readSecretAccessKey
      ? { access_key_id: opts.readAccessKeyId, secret_access_key: opts.readSecretAccessKey }
      : undefined) ??
    envCredentials("DOSU_SOURCE") ??
    (await askKeyPair(ask, "Dosu's read-only keys (GetObject + ListBucket)", undefined));

  let tokenSecret = opts.clearTokenSecret
    ? undefined
    : (opts.tokenSecret ?? process.env.DOSU_STORE_TOKEN_SECRET);
  // Dosu keeps the secret it has when this is the same server and none is given.
  const keeps =
    current?.kind === "server" && current.issues_tokens && current.server_url === serverUrl;
  if (kind === "server" && tokenSecret === undefined && !opts.clearTokenSecret && !opts.yes) {
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
  if (kind !== "server" && (tokenSecret || opts.clearTokenSecret)) {
    throw new CliUsageError("the token secret is a server's: only a server store has one");
  }
  return {
    kind,
    ...(serverUrl ? { server_url: serverUrl } : {}),
    bucket_kind: r2 ? "r2" : "s3",
    bucket: parsed.bucket,
    prefix: parsed.prefix,
    ...(region ? { region } : {}),
    ...(accountId ? { account_id: accountId } : {}),
    ...(endpoint ? { endpoint } : {}),
    ...read,
    ...(tokenSecret ? { token_secret: tokenSecret } : {}),
    ...(opts.clearTokenSecret ? { clear_token_secret: true } : {}),
  };
}

function setupCommand(): Command {
  return new Command("setup")
    .description(
      "Set where the org's sessions go (org admins): Dosu's sessiondb (--hosted), the org's sessiondb server (--server, with the bucket it writes), or a bucket members write directly (--bucket). Dosu gets a read-only key to the bucket; members never see it. Every member's 'dosu setup' then enrolls for their own folder",
    )
    .option("--hosted", "Dosu's sessiondb")
    .option("--server <url>", "The org's sessiondb server, https://sessions.example.com")
    .option(
      "--bucket <url>",
      "The bucket sessions land in: s3://bucket/prefix or r2://bucket/prefix",
    )
    .option("--region <region>", "AWS region of an s3:// bucket (default: us-east-1)")
    .option("--account-id <id>", "Cloudflare account id of an r2:// bucket")
    .option("--endpoint <url>", "S3-compatible endpoint (MinIO, Backblaze…) of an s3:// bucket")
    .option(
      "--read-access-key-id <id>",
      "Key Dosu reads the bucket with, read-only (or DOSU_SOURCE_ACCESS_KEY_ID)",
    )
    .option("--read-secret-access-key <secret>", "Secret for --read-access-key-id")
    .option(
      "--token-secret <secret>",
      "The server's SESSIONDB_TOKEN_SECRET, so Dosu signs member tokens (or DOSU_STORE_TOKEN_SECRET). Omitted, Dosu keeps the one it has for the same server",
    )
    .option(
      "--clear-token-secret",
      "Forget the token secret: members then paste tokens you issue from SESSIONDB_TOKENS",
    )
    .option("-y, --yes", "Never prompt; every answer comes from flags, environment or defaults")
    .option("--json", "Output as JSON")
    .action(async (opts: StoreSetupOptions) => {
      const api = requireStoreApi(loadConfig());
      const current = await orgStore(api);
      const body = await storeRequest({ ...opts, yes: opts.yes || opts.json }, current);
      let store: SessionStore;
      try {
        store = await api.set(body);
      } catch (err) {
        if (err instanceof SourcesApiError && err.status === 403) {
          throw new CliUsageError("only an org admin can set the org's session store");
        }
        throw err;
      }
      if (opts.json) {
        printResult(store, opts);
        return;
      }
      console.log(`${pc.green("✓")} The org's sessions go to ${describeStore(store)}.`);
      if (store.kind === "bucket") {
        console.log(
          pc.dim(
            `  Give each member a write key scoped to ${store.url}/owners/<their folder>/ by bucket policy; one shared key lets members read each other's folders.`,
          ),
        );
      } else if (store.kind === "server" && !store.issues_tokens) {
        console.log(
          pc.dim("  Give each member a token of their own from the server's SESSIONDB_TOKENS."),
        );
      }
      console.log(pc.dim("  Members run 'dosu setup' (or 'dosu sources store join') to enroll."));
    });
}

// --- status ------------------------------------------------------------------

function statusCommand(): Command {
  return new Command("status")
    .description("The org's session store, your folder in it, and (to an admin) who has enrolled")
    .option("--json", "Output as JSON")
    .action(async (opts: { json?: boolean }) => {
      const api = requireStoreApi(loadConfig());
      let store: SessionStore;
      try {
        store = await api.get();
      } catch (err) {
        if (err instanceof SourcesApiError && err.status === 404) {
          throw new CliUsageError(
            "the org has no session store: an org admin sets one with 'dosu sources store setup'",
          );
        }
        throw err;
      }
      if (opts.json) {
        printResult(store, opts);
        return;
      }
      console.log(
        `${describeStore(store)}${store.configured ? "" : " (the default; no admin has set one)"}`,
      );
      if (store.url) console.log(pc.dim(`  bucket: ${store.url}`));
      console.log(
        pc.dim(
          store.issues_tokens
            ? "  Dosu signs each member's token"
            : store.kind === "server"
              ? "  members paste a token the admin issued"
              : "  members write with their own key",
        ),
      );
      console.log(store.owner ? `You ship as ${store.owner}.` : "You have not enrolled.");
      if (store.members) {
        if (store.members.length === 0) {
          console.log("No one has enrolled yet.");
          return;
        }
        printTable(
          ["OWNER", "USER", "STATE", "LAST SYNC"],
          store.members.map((m) => [
            m.owner,
            m.user_id,
            m.enabled ? (m.last_error ? "error" : "ok") : "moved",
            m.last_synced_at ? formatAge(m.last_synced_at) : "never",
          ]),
        );
      }
    });
}

// --- join (member) -----------------------------------------------------------

interface JoinOptions {
  token?: string;
  owner?: string;
  writeAccessKeyId?: string;
  writeSecretAccessKey?: string;
  name?: string;
  default?: boolean;
  yes?: boolean;
  json?: boolean;
}

function joinCommand(): Command {
  return new Command("join")
    .description(
      "Enroll in the org's session store, as 'dosu setup' does: your own folder in it, read by Dosu with the org's key. Again with --owner moves you to another folder",
    )
    .option("--token <token>", "A server store: the token your admin gave you")
    .option(
      "--owner <name>",
      "A bucket store: your folder, owners/<name>/ (default: your user name)",
    )
    .option(
      "--write-access-key-id <id>",
      "A bucket store: the key this machine writes with (or DOSU_BUCKET_ACCESS_KEY_ID)",
    )
    .option("--write-secret-access-key <secret>", "Secret for --write-access-key-id")
    .option("--name <name>", "The target's name in config (default: org)")
    .option("--no-default", "Keep the current default target")
    .option("-y, --yes", "Never prompt; every answer comes from flags, environment or defaults")
    .option("--json", "Output as JSON")
    .action(async (opts: JoinOptions) => {
      if (Boolean(opts.writeAccessKeyId) !== Boolean(opts.writeSecretAccessKey)) {
        throw new CliUsageError("--write-access-key-id and --write-secret-access-key go together");
      }
      const cfg = loadConfig();
      const api = requireStoreApi(cfg);
      let store: SessionStore;
      try {
        store = await api.get();
      } catch (err) {
        if (err instanceof SourcesApiError && err.status === 404) {
          throw new CliUsageError(
            "the org has no session store: an org admin sets one with 'dosu sources store setup'",
          );
        }
        throw err;
      }
      const joined = await joinOrgStore(cfg, api, store, {
        ...(opts.token ? { token: opts.token } : {}),
        ...(opts.owner ? { owner: opts.owner } : {}),
        ...(opts.writeAccessKeyId && opts.writeSecretAccessKey
          ? {
              write: {
                access_key_id: opts.writeAccessKeyId,
                secret_access_key: opts.writeSecretAccessKey,
              },
            }
          : {}),
        ...(opts.name ? { name: opts.name } : {}),
        ...(opts.default === false ? { makeDefault: false } : {}),
        ...(opts.yes || opts.json ? { yes: true } : {}),
      });
      if (!joined) {
        console.log("Cancelled; nothing saved.");
        return;
      }
      const { target, enrollment } = joined;
      if (opts.json) {
        printResult(
          {
            target:
              "token" in target
                ? { ...target, token: "***" }
                : { ...target, secret_access_key: "***" },
            source: enrollment.source,
          },
          opts,
        );
        return;
      }
      console.log(`${pc.green("✓")} Sessions ship to ${describeStore(store)} as ${target.owner}.`);
      console.log(pc.dim("  Dosu reads new sessions within a few minutes of each upload."));
    });
}
