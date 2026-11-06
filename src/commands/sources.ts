/** `dosu sources`: the sessiondb server this machine ships to (`setup`), and the bucket it
 * writes registered with Dosu so the backend pulls its sessions into memory (`connect`), what
 * the backend has seen of it (`status`), a sync right now instead of at the next interval
 * (`sync`), and forgetting the connection (`disconnect`). The bucket stays the user's archive
 * throughout; only the connection changes. */

import { Command } from "commander";
import pc from "picocolors";
import { CliUsageError } from "../cli/errors";
import { type Config, loadConfig, saveConfig } from "../config/config";
import type { SessionTarget } from "../config/schema";
import { configuredTargets, isBucketTarget, selectTarget } from "../config/targets";
import {
  type ConnectSourceRequest,
  requireSourcesApi,
  type SourceStatus,
  type SourcesApi,
  SourcesApiError,
} from "../sources/api";
import {
  type BucketWizardInput,
  type BucketWizardResult,
  runBucketWizard,
} from "../sources/bucket-wizard";
import { bucketOfStorage } from "../sources/connect";
import { setupHostedTarget } from "../sources/hosted";
import {
  bucketOfTarget,
  runServerWizard,
  type ServerWizardInput,
  type ServerWizardResult,
} from "../sources/server-wizard";
import { confirm, isCancel } from "../tui/prompts";
import { formatAge, printResult, printTable, truncate } from "./output";

export function sourcesCommand(): Command {
  const cmd = new Command("sources").description(
    "Your sessiondb server, and its bucket connected to Dosu, which pulls the sessions into memory",
  );
  cmd.addCommand(setupCommand());
  cmd.addCommand(connectCommand());
  cmd.addCommand(statusCommand());
  cmd.addCommand(syncCommand());
  cmd.addCommand(disconnectCommand());
  return cmd;
}

// --- target selection --------------------------------------------------------

interface TargetSelection {
  target?: string;
}

/** The target a sources command is about: `--target`, else the default, else the only one. */
function selectServer(cfg: Config, selection: TargetSelection): SessionTarget {
  let target: SessionTarget | undefined;
  try {
    target = selectTarget(cfg, selection.target);
  } catch (err) {
    throw new CliUsageError(err instanceof Error ? err.message : String(err));
  }
  if (!target) {
    throw new CliUsageError(
      "no sessiondb target configured: run 'dosu sources setup --hosted' (Dosu's), 'dosu sources setup --server <url> --token <token>' (your own server) or 'dosu sources setup --bucket <url>' (your bucket, no server)",
    );
  }
  return target;
}

/** The bucket behind a target: a bucket target's own, or what a server says it writes. */
async function bucketOf(target: SessionTarget): ReturnType<typeof bucketOfTarget> {
  if (!isBucketTarget(target)) return bucketOfTarget(target);
  const parsed = bucketOfStorage({
    url: target.url,
    ...(target.endpoint ? { endpoint: target.endpoint } : {}),
  });
  if (!parsed) throw new CliUsageError(`${target.url} is not a bucket Dosu can read`);
  return {
    url: target.url,
    scheme: parsed.provider === "r2" ? "r2" : "s3",
    bucket: parsed.bucket,
    prefix: parsed.prefix,
    ...(target.region ? { region: target.region } : {}),
    ...(target.account_id ? { account_id: target.account_id } : {}),
    ...(target.endpoint ? { endpoint: target.endpoint } : {}),
  };
}

/** Persist the source id on the configured target. */
function rememberSourceId(target: SessionTarget, sourceId: string | undefined): void {
  const cfg = loadConfig();
  const configured = configuredTargets(cfg).find((t) => t.name === target.name);
  if (!configured) return;
  if (sourceId) configured.source_id = sourceId;
  else delete configured.source_id;
  saveConfig(cfg);
}

/** The source behind a target: by the id the config remembers, else by bucket URL and owner
 * among the login's sources (a target connected from another machine, or before this field). */
async function findSource(
  api: SourcesApi,
  target: SessionTarget,
): Promise<SourceStatus | undefined> {
  if (target.source_id) {
    try {
      return await api.get(target.source_id);
    } catch (err) {
      if (!(err instanceof SourcesApiError) || err.status !== 404) throw err;
      // Disconnected elsewhere; fall through to a lookup and forget the stale id.
      rememberSourceId(target, undefined);
    }
  }
  const sources = await api.list();
  // Matched by the bucket behind the target, when it can be said.
  const url = await bucketOf(target).then(
    (b) => b.url,
    () => target.url,
  );
  const match = sources.find((s) => s.url === url && s.owner === target.owner);
  if (match) rememberSourceId(target, match.id);
  return match;
}

async function requireSource(api: SourcesApi, target: SessionTarget): Promise<SourceStatus> {
  const source = await findSource(api, target);
  if (!source) {
    throw new CliUsageError(
      `target ${target.name} (${target.url}) is not connected to Dosu: run 'dosu sources connect --target ${target.name}'`,
    );
  }
  return source;
}

// --- setup -------------------------------------------------------------------

interface SetupOptions {
  hosted?: boolean;
  server?: string;
  token?: string;
  bucket?: string;
  region?: string;
  accountId?: string;
  endpoint?: string;
  owner?: string;
  writeAccessKeyId?: string;
  writeSecretAccessKey?: string;
  name?: string;
  readAccessKeyId?: string;
  readSecretAccessKey?: string;
  connect?: boolean;
  default?: boolean;
  yes?: boolean;
  json?: boolean;
}

/** `dosu sources setup --bucket` flags as the bucket wizard's answers. */
function bucketInputFromOptions(opts: SetupOptions): BucketWizardInput {
  if (Boolean(opts.writeAccessKeyId) !== Boolean(opts.writeSecretAccessKey)) {
    throw new CliUsageError("--write-access-key-id and --write-secret-access-key go together");
  }
  const { server: _server, token: _token, ...shared } = wizardInputFromOptions(opts);
  return {
    ...shared,
    ...(opts.bucket ? { bucket: opts.bucket } : {}),
    ...(opts.region ? { region: opts.region } : {}),
    ...(opts.accountId ? { accountId: opts.accountId } : {}),
    ...(opts.endpoint ? { endpoint: opts.endpoint } : {}),
    ...(opts.owner ? { owner: opts.owner } : {}),
    ...(opts.writeAccessKeyId && opts.writeSecretAccessKey
      ? {
          write: {
            access_key_id: opts.writeAccessKeyId,
            secret_access_key: opts.writeSecretAccessKey,
          },
        }
      : {}),
  };
}

/** `dosu sources setup` flags as wizard answers; a pair given by halves is an error. */
export function wizardInputFromOptions(opts: SetupOptions): ServerWizardInput {
  if (Boolean(opts.readAccessKeyId) !== Boolean(opts.readSecretAccessKey)) {
    throw new CliUsageError("--read-access-key-id and --read-secret-access-key go together");
  }
  return {
    ...(opts.server ? { server: opts.server } : {}),
    ...(opts.token ? { token: opts.token } : {}),
    ...(opts.name ? { name: opts.name } : {}),
    ...(opts.readAccessKeyId && opts.readSecretAccessKey
      ? {
          read: {
            access_key_id: opts.readAccessKeyId,
            secret_access_key: opts.readSecretAccessKey,
          },
        }
      : {}),
    ...(opts.connect === false ? { connect: false } : {}),
    ...(opts.default === false ? { makeDefault: false } : {}),
    ...(opts.yes ? { yes: true } : {}),
  };
}

function setupCommand(): Command {
  return new Command("setup")
    .alias("add")
    .description(
      "Choose where this machine's sessions go: Dosu's sessiondb with --hosted (one call to your login, nothing to paste), your own sessiondb server (--server, checks the token), or your own bucket with --bucket (redacted here and written with a key this machine keeps; no server). Each makes it where 'dosu sync' ships and lets Dosu read the bucket. Every answer can be a flag; --yes never prompts",
    )
    .option("--hosted", "Use Dosu's sessiondb: Dosu stores your sessions and learns from them")
    .option("--server <url>", "Your own server, https://sessions.example.com")
    .option("--token <token>", "The server token (sdb_…) minted for you")
    .option(
      "--bucket <url>",
      "Your own bucket, no server: s3://bucket/prefix or r2://bucket/prefix",
    )
    .option("--region <region>", "AWS region of an s3:// bucket (default: us-east-1)")
    .option("--account-id <id>", "Cloudflare account id of an r2:// bucket")
    .option("--endpoint <url>", "S3-compatible endpoint (MinIO, Backblaze…) of an s3:// bucket")
    .option("--owner <name>", "Your folder in the bucket, owners/<name>/ (default: your user name)")
    .option(
      "--write-access-key-id <id>",
      "Key this machine writes the bucket with (or DOSU_BUCKET_ACCESS_KEY_ID)",
    )
    .option("--write-secret-access-key <secret>", "Secret for --write-access-key-id")
    .option("--name <name>", "The target's name in config (default: server, or bucket)")
    .option("--read-access-key-id <id>", "Key Dosu reads the bucket with (read-only is enough)")
    .option("--read-secret-access-key <secret>", "Secret for --read-access-key-id")
    .option("--no-connect", "Save the target without letting Dosu read its bucket")
    .option("--no-default", "Keep the current default target; this one is reachable with --target")
    .option("-y, --yes", "Never prompt; every answer comes from flags, environment or defaults")
    .option("--json", "Output as JSON")
    .action(async (opts: SetupOptions) => {
      const cfg = loadConfig();
      if (opts.hosted) {
        if (
          opts.server ||
          opts.token ||
          opts.bucket ||
          opts.readAccessKeyId ||
          opts.readSecretAccessKey
        ) {
          throw new CliUsageError(
            "--hosted is Dosu's server: --server, --token, --bucket and the read keys are for your own",
          );
        }
        const { target, source } = await setupHostedTarget(cfg, requireSourcesApi(cfg), {
          ...(opts.name ? { name: opts.name } : {}),
          ...(opts.default === false ? { makeDefault: false } : {}),
        });
        if (opts.json) {
          printResult({ target: { ...target, token: "***" }, source }, opts);
          return;
        }
        console.log(
          `${pc.green("✓")} Sessions ship to Dosu's sessiondb as ${target.owner}${
            cfg.default_target === target.name ? "" : ` ('dosu sync --target ${target.name}')`
          }.`,
        );
        console.log(pc.dim("  Dosu reads new sessions within a few minutes of each upload."));
        return;
      }
      const yes = opts.yes || opts.json ? { yes: true } : {};
      if (opts.bucket) {
        if (opts.server || opts.token) {
          throw new CliUsageError(
            "--bucket is written from this machine: --server and --token are for a server",
          );
        }
        const result: BucketWizardResult | null = await runBucketWizard(cfg, {
          ...bucketInputFromOptions(opts),
          ...yes,
        });
        if (!result) {
          console.log("Cancelled; nothing saved.");
          return;
        }
        if (opts.json) {
          printResult(
            {
              target: { ...result.target, secret_access_key: "***" },
              ...(result.source ? { source: result.source } : {}),
              ...(result.connectError ? { connect_error: result.connectError } : {}),
            },
            opts,
          );
          return;
        }
        if (result.source) {
          try {
            await requireSourcesApi(loadConfig()).sync(result.source.id);
          } catch {
            // The scheduled read covers it.
          }
        }
        return;
      }
      const result: ServerWizardResult | null = await runServerWizard(cfg, {
        ...wizardInputFromOptions(opts),
        ...yes,
      });
      if (!result) {
        console.log("Cancelled; nothing saved.");
        return;
      }
      if (opts.json) {
        printResult(
          {
            target: { ...result.target, token: "***" },
            ...(result.source ? { source: result.source } : {}),
            ...(result.connectError ? { connect_error: result.connectError } : {}),
          },
          opts,
        );
        return;
      }
      if (result.source) {
        try {
          await requireSourcesApi(loadConfig()).sync(result.source.id);
          console.log(
            pc.dim("  Dosu is reading the bucket now; 'dosu sources status' follows it."),
          );
        } catch {
          // The scheduled read covers it.
        }
      }
    });
}

// --- connect -----------------------------------------------------------------

interface ReadCredentials {
  access_key_id: string;
  secret_access_key: string;
  session_token?: string;
}

/** Where the keys Dosu will read the bucket with come from, in order: flags,
 * `--read-credentials-stdin`, `DOSU_SOURCE_*` environment variables. This machine holds no
 * bucket keys of its own. */
export async function readCredentials(opts: {
  accessKeyId?: string;
  secretAccessKey?: string;
  sessionToken?: string;
  readCredentialsStdin?: boolean;
}): Promise<{ credentials: ReadCredentials; from: string }> {
  if (opts.accessKeyId || opts.secretAccessKey) {
    if (!opts.accessKeyId || !opts.secretAccessKey) {
      throw new CliUsageError("--access-key-id and --secret-access-key go together");
    }
    return {
      credentials: {
        access_key_id: opts.accessKeyId,
        secret_access_key: opts.secretAccessKey,
        ...(opts.sessionToken ? { session_token: opts.sessionToken } : {}),
      },
      from: "flags",
    };
  }
  if (opts.readCredentialsStdin) {
    return { credentials: parseStdinCredentials(await readStdin()), from: "stdin" };
  }
  const envId = process.env.DOSU_SOURCE_ACCESS_KEY_ID;
  const envSecret = process.env.DOSU_SOURCE_SECRET_ACCESS_KEY;
  if (envId && envSecret) {
    const token = process.env.DOSU_SOURCE_SESSION_TOKEN;
    return {
      credentials: {
        access_key_id: envId,
        secret_access_key: envSecret,
        ...(token ? { session_token: token } : {}),
      },
      from: "DOSU_SOURCE_* environment",
    };
  }
  throw new CliUsageError(
    "no credentials for Dosu to read the bucket with: pass --access-key-id/--secret-access-key, pipe them with --read-credentials-stdin (JSON or two lines), or set DOSU_SOURCE_ACCESS_KEY_ID/DOSU_SOURCE_SECRET_ACCESS_KEY. A read-only key pair is enough.",
  );
}

/** JSON `{access_key_id, secret_access_key, session_token?}`, or `id\nsecret[\ntoken]`. */
export function parseStdinCredentials(text: string): ReadCredentials {
  const trimmed = text.trim();
  if (trimmed.startsWith("{")) {
    let parsed: Record<string, unknown>;
    try {
      parsed = JSON.parse(trimmed) as Record<string, unknown>;
    } catch {
      throw new CliUsageError("--read-credentials-stdin: stdin is not valid JSON");
    }
    const id = parsed.access_key_id ?? parsed.accessKeyId;
    const secret = parsed.secret_access_key ?? parsed.secretAccessKey;
    const token = parsed.session_token ?? parsed.sessionToken;
    if (typeof id !== "string" || typeof secret !== "string" || !id || !secret) {
      throw new CliUsageError(
        "--read-credentials-stdin: JSON needs access_key_id and secret_access_key",
      );
    }
    return {
      access_key_id: id,
      secret_access_key: secret,
      ...(typeof token === "string" && token ? { session_token: token } : {}),
    };
  }
  const [id, secret, token] = trimmed
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
  if (!id || !secret) {
    throw new CliUsageError(
      "--read-credentials-stdin: expected the access key id on line 1 and the secret on line 2 (session token on line 3), or a JSON object",
    );
  }
  return {
    access_key_id: id,
    secret_access_key: secret,
    ...(token ? { session_token: token } : {}),
  };
}

async function readStdin(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) chunks.push(Buffer.from(chunk));
  return Buffer.concat(chunks).toString("utf8");
}

function connectCommand(): Command {
  return new Command("connect")
    .description(
      "Register the server's bucket as a Dosu source: Dosu reads it (with the keys you give it here) and pulls new sessions into memory every few minutes",
    )
    .option("--target <name>", "Which configured server (default: the default, or the only one)")
    .option("--name <name>", "How Dosu labels the source (default: the target's name)")
    .option(
      "--endpoint <url>",
      "S3-compatible endpoint Dosu reads through, when it differs from the target's (a VPC endpoint, an internal MinIO)",
    )
    .option("--access-key-id <id>", "Key Dosu reads the bucket with (read-only is enough)")
    .option("--secret-access-key <secret>", "Secret for --access-key-id")
    .option("--session-token <token>", "Session token, for temporary credentials")
    .option(
      "--read-credentials-stdin",
      "Read the key pair from stdin: JSON {access_key_id, secret_access_key} or two lines",
    )
    .option(
      "--lag <seconds>",
      "How far behind its cursor Dosu re-reads each sync, absorbing clock skew between machines writing the bucket (default: 300)",
    )
    .option("--json", "Output as JSON")
    .action(
      async (opts: {
        target?: string;
        name?: string;
        endpoint?: string;
        accessKeyId?: string;
        secretAccessKey?: string;
        sessionToken?: string;
        readCredentialsStdin?: boolean;
        lag?: string;
        json?: boolean;
      }) => {
        const cfg = loadConfig();
        const api = requireSourcesApi(cfg);
        // Nothing to connect yet and a person at the keyboard: the guided setup instead.
        if (
          !opts.target &&
          configuredTargets(cfg).length === 0 &&
          process.stdin.isTTY &&
          !opts.json
        ) {
          const result = await runServerWizard(cfg, {
            ...(opts.name ? { name: opts.name } : {}),
            ...(opts.accessKeyId && opts.secretAccessKey
              ? {
                  read: {
                    access_key_id: opts.accessKeyId,
                    secret_access_key: opts.secretAccessKey,
                    ...(opts.sessionToken ? { session_token: opts.sessionToken } : {}),
                  },
                }
              : {}),
          });
          if (!result) console.log("Cancelled; nothing saved.");
          return;
        }
        const target = selectServer(cfg, opts);
        const existing = await findSource(api, target);
        if (existing) {
          if (opts.json) {
            printResult(existing, opts);
            return;
          }
          console.log(
            `${pc.green("✓")} ${target.name} is already connected as "${existing.name}" (${existing.id}).`,
          );
          console.log(pc.dim("  'dosu sources status' shows what Dosu has read of it."));
          return;
        }

        const { credentials, from } = await readCredentials(opts);
        // A bucket target names its bucket; a server is asked which it writes to.
        const store = await bucketOf(target);
        const { scheme, bucket, prefix } = store;
        const lag = opts.lag === undefined ? undefined : Number.parseInt(opts.lag, 10);
        if (lag !== undefined && (!Number.isFinite(lag) || lag < 0)) {
          throw new CliUsageError(
            `--lag must be a non-negative number of seconds, got '${opts.lag}'`,
          );
        }
        const body: Omit<ConnectSourceRequest, "deployment_id"> = {
          kind: scheme,
          bucket,
          prefix,
          owner: target.owner,
          ...(store.region ? { region: store.region } : {}),
          ...(store.account_id ? { account_id: store.account_id } : {}),
          ...((opts.endpoint ?? store.endpoint)
            ? { endpoint: opts.endpoint ?? store.endpoint }
            : {}),
          ...credentials,
          name: opts.name ?? target.name,
          ...(lag !== undefined ? { lag_seconds: lag } : {}),
        };

        let source: SourceStatus;
        try {
          source = await api.connect(body);
        } catch (err) {
          if (err instanceof SourcesApiError && (err.status === 400 || err.status === 422)) {
            throw new CliUsageError(
              `Dosu could not read ${store.url} with the ${from} keys: ${err.message}`,
            );
          }
          throw err;
        }
        rememberSourceId(target, source.id);

        if (opts.json) {
          printResult(source, opts);
          return;
        }
        console.log(`${pc.green("✓")} Dosu can read ${source.url}.`);
        console.log(
          `${pc.green("✓")} Source "${source.name}" connected (${source.id}); keys from ${from}, encrypted at rest.`,
        );
        if (source.layout_created_by) {
          console.log(pc.dim(`  layout written by ${source.layout_created_by}`));
        }
        console.log(
          pc.dim(
            `  First sync within a few minutes; 'dosu sources sync' starts one now, 'dosu sources status' shows progress.`,
          ),
        );
      },
    );
}

// --- status ------------------------------------------------------------------

function statusCommand(): Command {
  return new Command("status")
    .description("What Dosu has read of a connected bucket: cursor, last sync, errors")
    .option("--target <name>", "Which configured server (default: the default, or the only one)")
    .option("--all", "Every source connected under this login, one line each")
    .option("--json", "Output as JSON")
    .action(async (opts: { target?: string; all?: boolean; json?: boolean }) => {
      const cfg = loadConfig();
      const api = requireSourcesApi(cfg);
      if (opts.all) {
        const sources = await api.list();
        if (opts.json) {
          printResult({ sources }, opts);
          return;
        }
        if (sources.length === 0) {
          console.log(
            "No sources connected. 'dosu sources connect' registers your server's bucket.",
          );
          return;
        }
        printTable(
          ["NAME", "URL", "OWNER", "LAST SYNC", "BEHIND", "STATE", "ID"],
          sources.map((s) => [
            s.name,
            truncate(s.url, 40),
            s.owner,
            s.last_synced_at ? formatAge(s.last_synced_at) : "never",
            String(s.last_sync_remaining),
            sourceState(s),
            s.id,
          ]),
        );
        return;
      }
      const target = selectServer(cfg, opts);
      const source = await requireSource(api, target);
      if (opts.json) {
        printResult(source, opts);
        return;
      }
      printSourceStatus(source, target);
    });
}

function sourceState(s: SourceStatus): string {
  if (!s.enabled) return "disabled";
  if (s.last_error) return `error ×${s.error_count}`;
  return "ok";
}

function printSourceStatus(s: SourceStatus, target: SessionTarget, now: Date = new Date()): void {
  const dot = !s.enabled ? pc.dim("○") : s.last_error ? pc.yellow("●") : pc.green("●");
  console.log(`${dot} ${s.name} ${pc.dim(`(${s.id})`)}`);
  console.log(`  Target:     ${target.name} → ${s.url}`);
  console.log(
    `  Last sync:  ${
      s.last_synced_at
        ? `${formatAge(s.last_synced_at, now)} · ${s.last_sync_processed} processed`
        : "not yet"
    }`,
  );
  console.log(`  Cursor:     ${s.cursor ?? "start of changes/"}`);
  console.log(
    `  Behind:     ${s.last_sync_remaining} change${s.last_sync_remaining === 1 ? "" : "s"} · re-reads ${s.lag_seconds}s of lag`,
  );
  if (!s.enabled)
    console.log(pc.yellow("  Disabled by Dosu; 'dosu sources connect' again re-enables."));
  if (s.last_error) {
    console.log(pc.yellow(`  Last error: ${s.last_error} (${s.error_count} in a row)`));
  }
  const recent = s.recent ?? [];
  if (recent.length > 0) {
    console.log("  Recent:");
    for (const c of recent.slice(0, 10)) {
      const detail = c.detail ? ` ${pc.dim(`· ${truncate(c.detail, 60)}`)}` : "";
      console.log(
        `    ${formatAge(c.processed_at, now).padEnd(10)} ${c.kind.padEnd(12)} ${c.outcome.padEnd(10)} ${truncate(c.key, 48)}${detail}`,
      );
    }
  }
}

// --- sync --------------------------------------------------------------------

function syncCommand(): Command {
  return new Command("sync")
    .description("Ask Dosu to read the bucket now instead of at the next interval")
    .option("--target <name>", "Which configured server (default: the default, or the only one)")
    .option("--json", "Output as JSON")
    .action(async (opts: { target?: string; json?: boolean }) => {
      const cfg = loadConfig();
      const api = requireSourcesApi(cfg);
      const target = selectServer(cfg, opts);
      const source = await requireSource(api, target);
      const queued = await api.sync(source.id);
      if (opts.json) {
        printResult(queued, opts);
        return;
      }
      console.log(
        `${pc.green("✓")} Sync queued for "${source.name}" (${source.url}); 'dosu sources status' shows what it read.`,
      );
    });
}

// --- disconnect --------------------------------------------------------------

function disconnectCommand(): Command {
  return new Command("disconnect")
    .description(
      "Forget the bucket and the keys Dosu held for it; sessions already in memory stay ('dosu redact' removes one)",
    )
    .option("--target <name>", "Which configured server (default: the default, or the only one)")
    .option("-y, --yes", "Skip the confirmation")
    .option("--json", "Output as JSON")
    .action(async (opts: { target?: string; yes?: boolean; json?: boolean }) => {
      const cfg = loadConfig();
      const api = requireSourcesApi(cfg);
      const target = selectServer(cfg, opts);
      const source = await requireSource(api, target);
      if (!opts.yes && !opts.json) {
        const ok = await confirm({
          message: `Disconnect "${source.name}" (${source.url})? Dosu stops reading it and drops its keys; the bucket itself is untouched.`,
          initialValue: false,
        });
        if (isCancel(ok) || !ok) {
          console.log("Cancelled.");
          return;
        }
      }
      await api.disconnect(source.id);
      rememberSourceId(target, undefined);
      if (opts.json) {
        printResult({ id: source.id, disconnected: true }, opts);
        return;
      }
      console.log(
        `${pc.green("✓")} "${source.name}" disconnected; ${target.name} is an archive again.`,
      );
    });
}
