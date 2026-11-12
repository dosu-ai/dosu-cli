/** `dosu sources`: where this machine's sessions go (`setup`: the org's session store, which only
 * an org admin sets, and whether this machine ships there), what Dosu has read of each connection
 * (`status`, `list`), a read right now instead of at the next interval (`sync`), and forgetting a
 * connection (`disconnect`). `store` is the org's store itself.
 *
 * A bucket is always the org's: an org admin sets it as the org's store (`dosu sources store
 * setup`, or `setup` with no store yet), and members write their own folder of it. There is no
 * connecting a bucket of one's own. The connections listed here are the org store's (a member's
 * folder, the raw logs other tools drop beside them, Dosu's hosted sessiondb) and ones made
 * before buckets were the org's, which Dosu keeps reading until they are disconnected. */

import { Command } from "commander";
import pc from "picocolors";
import { CliUsageError } from "../cli/errors";
import { type Config, loadConfig, saveConfig } from "../config/config";
import type { SessionTarget } from "../config/schema";
import { configuredTargets, isBucketTarget, selectTarget } from "../config/targets";
import {
  requireSourcesApi,
  requireStoreApi,
  type SourceStatus,
  type SourcesApi,
  SourcesApiError,
  sourcesApi,
} from "../sources/api";
import { bucketOfStorage, parseAgent } from "../sources/bucket";
import { formatCounts, plural } from "../sources/detect";
import { asker, askShip } from "../sources/prompts";
import { bucketOfTarget } from "../sources/server-client";
import { describeStore, joinOrgStore } from "../sources/store";
import {
  decideStore,
  type StoreChoiceInput,
  storeKindOf,
  storeNotes,
} from "../sources/store-setup";
import { confirm, isCancel } from "../tui/prompts";
import { formatAge, printResult, printTable, truncate } from "./output";
import { storeCommand } from "./sources-store";

export function sourcesCommand(): Command {
  const cmd = new Command("sources").description(
    "Where your org's sessions live and whether this machine ships there; what Dosu reads of them",
  );
  cmd.addCommand(setupCommand());
  cmd.addCommand(connectCommand(), { hidden: true });
  cmd.addCommand(statusCommand());
  cmd.addCommand(listCommand());
  cmd.addCommand(syncCommand());
  cmd.addCommand(disconnectCommand());
  cmd.addCommand(storeCommand());
  return cmd;
}

// --- target and connection selection ----------------------------------------

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
      "no sessiondb target configured: 'dosu sources setup' ships this machine's sessions to the org's session store",
    );
  }
  return target;
}

/** The bucket behind a target: a bucket target's own, or what a server says it writes. */
async function bucketOf(target: SessionTarget): ReturnType<typeof bucketOfTarget> {
  if (!isBucketTarget(target)) return bucketOfTarget(target);
  // Config only keeps a bucket target whose URL bucketOfStorage parses.
  const parsed = bucketOfStorage({ url: target.url, endpoint: target.endpoint }) as NonNullable<
    ReturnType<typeof bucketOfStorage>
  >;
  return {
    url: target.url,
    scheme: target.url.slice(0, 2) as "s3" | "r2",
    bucket: parsed.bucket,
    prefix: parsed.prefix,
    region: target.region,
    account_id: target.account_id,
    endpoint: target.endpoint,
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
      `Dosu reads nothing through target ${target.name} (${target.url}): 'dosu sources setup' enrolls this machine in the org's session store`,
    );
  }
  return source;
}

interface Selection extends TargetSelection {
  /** A connection by id or name, connected or not to a target of this machine. */
  source?: string;
}

/** The connection a command is about: `--source` (id or name), else the target's, else, on a
 * machine with no target, the login's only connection. Read in full (its recent changes and
 * files). */
async function selectSource(
  api: SourcesApi,
  cfg: Config,
  selection: Selection,
): Promise<{ source: SourceStatus; target?: SessionTarget }> {
  if (selection.source && selection.target) {
    throw new CliUsageError("--source and --target both name a connection; give one");
  }
  if (!selection.source && (selection.target || configuredTargets(cfg).length > 0)) {
    const target = selectServer(cfg, selection);
    return { source: await requireSource(api, target), target };
  }
  const sources = await api.list();
  let found: SourceStatus | undefined;
  if (selection.source) {
    found = sources.find((s) => s.id === selection.source || s.name === selection.source);
    if (!found) {
      throw new CliUsageError(
        `no connection '${selection.source}'; 'dosu sources list' shows them`,
      );
    }
  } else if (sources.length === 1) {
    found = sources[0];
  } else if (sources.length === 0) {
    throw new CliUsageError(
      "nothing connected: 'dosu sources setup' ships this machine's sessions to the org's session store",
    );
  } else {
    throw new CliUsageError(
      `${sources.length} connections; say which with --source <id or name> ('dosu sources list' shows them)`,
    );
  }
  const source = found as SourceStatus;
  const target = configuredTargets(cfg).find((t) => t.source_id === source.id);
  return { source: await api.get(source.id), ...(target ? { target } : {}) };
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
  readAccessKeyId?: string;
  readSecretAccessKey?: string;
  tokenSecret?: string;
  agent?: string;
  ship?: boolean;
  owner?: string;
  writeAccessKeyId?: string;
  writeSecretAccessKey?: string;
  name?: string;
  default?: boolean;
  yes?: boolean;
  json?: boolean;
}

/** The flags about the org's store, checked. */
function storeChoiceOf(opts: SetupOptions): StoreChoiceInput {
  if (Boolean(opts.readAccessKeyId) !== Boolean(opts.readSecretAccessKey)) {
    throw new CliUsageError("--read-access-key-id and --read-secret-access-key go together");
  }
  const kind = storeKindOf(opts);
  if (kind === "hosted" && (opts.token || opts.readAccessKeyId || opts.tokenSecret)) {
    throw new CliUsageError(
      "--hosted is Dosu's sessiondb: --token, the read keys and --token-secret are for the org's own",
    );
  }
  const agent = parseAgent(opts.agent);
  return {
    ...(kind ? { kind } : {}),
    ...(opts.server ? { server: opts.server } : {}),
    ...(opts.bucket ? { bucket: opts.bucket } : {}),
    ...(opts.region ? { region: opts.region } : {}),
    ...(opts.accountId ? { accountId: opts.accountId } : {}),
    ...(opts.endpoint ? { endpoint: opts.endpoint } : {}),
    ...(opts.readAccessKeyId && opts.readSecretAccessKey
      ? {
          read: {
            access_key_id: opts.readAccessKeyId,
            secret_access_key: opts.readSecretAccessKey,
          },
        }
      : {}),
    ...(opts.tokenSecret ? { tokenSecret: opts.tokenSecret } : {}),
    ...(agent ? { agent } : {}),
  };
}

async function runSetup(opts: SetupOptions): Promise<void> {
  if (Boolean(opts.writeAccessKeyId) !== Boolean(opts.writeSecretAccessKey)) {
    throw new CliUsageError("--write-access-key-id and --write-secret-access-key go together");
  }
  const choice = storeChoiceOf(opts);
  const yes = Boolean(opts.yes || opts.json);
  const cfg = loadConfig();
  const stores = requireStoreApi(cfg);
  const say = (line: string) => {
    if (!opts.json) console.log(line);
  };

  // Step 1: where the org's sessions live; only an admin with no store yet is asked.
  const decided = await decideStore(cfg, stores, sourcesApi(cfg), { ...choice, yes }, {}, say);
  if ("cancelled" in decided) {
    console.log("Cancelled; the org's session store is unchanged and nothing was saved.");
    return;
  }
  if ("noStore" in decided) {
    if (yes || !process.stdin.isTTY) throw new CliUsageError(decided.noStore);
    console.log(decided.noStore);
    return;
  }
  const { store, set } = decided;
  if (set && !opts.json) {
    console.log(`${pc.green("✓")} The org's sessions go to ${describeStore(store)}.`);
    for (const note of storeNotes(store)) console.log(pc.dim(`  ${note}`));
  }

  // Step 2: does this machine ship there? Named by a flag, yes unless --no-ship says otherwise.
  const ship = await askShip(asker(yes, {}), opts.ship ?? (choice.kind ? true : undefined));
  if (!ship) {
    if (opts.json) {
      printResult({ store, ship: false }, opts);
      return;
    }
    console.log(
      `${pc.green("✓")} This machine ships nothing; Dosu reads what other machines${
        store.kind === "bucket" ? " and tools" : ""
      } write to ${describeStore(store)}. 'dosu sources setup' again ships from here.`,
    );
    return;
  }
  const joined = await joinOrgStore(cfg, stores, store, {
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
    ...(yes ? { yes: true } : {}),
  });
  if (!joined) {
    console.log("Cancelled; nothing saved.");
    return;
  }
  const { target, enrollment } = joined;
  if (opts.json) {
    printResult(
      {
        store,
        target: isBucketTarget(target)
          ? { ...target, secret_access_key: "***" }
          : { ...target, token: "***" },
        source: enrollment.source,
      },
      opts,
    );
    return;
  }
  const saved = loadConfig();
  console.log(
    `${pc.green("✓")} Sessions ship to ${describeStore(store)} as ${target.owner}${
      saved.default_target === target.name ? "" : ` ('dosu sync --target ${target.name}')`
    }.`,
  );
  console.log(pc.dim("  Dosu reads new sessions within a few minutes of each upload."));
}

function setupCommand(): Command {
  return new Command("setup")
    .alias("add")
    .description(
      "Two questions. Where do the org's sessions live? That is the org's session store, set by an org admin: an org that has one (or uses Dosu's sessiondb by default) skips the question, and an admin with none answers it for the whole org: Dosu's sessiondb (--hosted), the org's sessiondb server (--server, with the --bucket it writes), or the org's bucket (--bucket: Dosu gets a READ-ONLY key and says what is there first; --agent names the format of the raw files other tools drop in it). Then: does this machine ship its own sessions there (--ship, the default, or --no-ship)? For a bucket, shipping keeps a write key to your own folder on this machine only. Anything written into the org's bucket reaches the org's memory, so a write key to it can add to that memory; Dosu still redacts every session. Every answer can be a flag; --yes never prompts",
    )
    .option("--hosted", "Org admins: the org's sessions live in Dosu's sessiondb")
    .option(
      "--server <url>",
      "Org admins: the org's sessiondb server, https://sessions.example.com (with --bucket, the bucket it writes)",
    )
    .option(
      "--bucket <url>",
      "Org admins: the org's bucket, s3://bucket/prefix or r2://bucket/prefix",
    )
    .option("--region <region>", "AWS region of an s3:// bucket (default: us-east-1)")
    .option("--account-id <id>", "Cloudflare account id of an r2:// bucket")
    .option("--endpoint <url>", "S3-compatible endpoint (MinIO, Backblaze…) of an s3:// bucket")
    .option(
      "--read-access-key-id <id>",
      "Org admins: the READ-ONLY key Dosu reads the bucket with (or DOSU_SOURCE_ACCESS_KEY_ID)",
    )
    .option("--read-secret-access-key <secret>", "Secret for --read-access-key-id")
    .option(
      "--token-secret <secret>",
      "Org admins, --server: the server's SESSIONDB_TOKEN_SECRET, so Dosu signs member tokens (or DOSU_STORE_TOKEN_SECRET)",
    )
    .option(
      "--agent <name>",
      "Org admins, --bucket: the format of every raw file other tools drop in it, overriding Dosu's per-file detection (claude-code, cursor, codex, opencode, pi, gemini-cli, atif, datadog-trajectory, trajectory)",
    )
    .option("--ship", "Ship this machine's sessions to the org's store (the default)")
    .option(
      "--no-ship",
      "This machine ships nothing (an MCP-only machine, or one whose sessions come from CI)",
    )
    .option(
      "--token <token>",
      "A server store without a token secret: the token your admin gave you",
    )
    .option(
      "--write-access-key-id <id>",
      "A bucket store: the key this machine writes your folder with, kept only here (or DOSU_BUCKET_ACCESS_KEY_ID)",
    )
    .option("--write-secret-access-key <secret>", "Secret for --write-access-key-id")
    .option(
      "--owner <name>",
      "A bucket store: your folder in it, owners/<name>/ (default: your user name)",
    )
    .option("--name <name>", "The target's name in config (default: org)")
    .option("--no-default", "Keep the current default target; this one is reachable with --target")
    .option("-y, --yes", "Never prompt; every answer comes from flags, environment or defaults")
    .option("--json", "Output as JSON")
    .action(runSetup);
}

// --- connect (gone) -----------------------------------------------------------

/** Kept so a script that still runs it is told what replaced it. */
function connectCommand(): Command {
  return new Command("connect")
    .description("Gone: a bucket is the org's session store, set by an org admin")
    .allowUnknownOption()
    .allowExcessArguments()
    .action(() => {
      throw new CliUsageError(
        "'dosu sources connect' is gone: a bucket is always the org's. An org admin makes it the org's session store with 'dosu sources store setup --bucket <url>' (or on the dashboard's Sources page), and each member's 'dosu sources setup' writes their own folder of it",
      );
    });
}

// --- status and list ---------------------------------------------------------

const selectionOptions = (cmd: Command): Command =>
  cmd
    .option("--target <name>", "Which configured target (default: the default, or the only one)")
    .option("--source <id or name>", "Which connection, by id or name ('dosu sources list')");

function statusCommand(): Command {
  return selectionOptions(
    new Command("status").description(
      "What Dosu has read of a connection: the sessiondb folder it reads, the raw files beside it (formats, files, sessions), last read, errors",
    ),
  )
    .option("--all", "Every connection this login sees, one line each (as 'dosu sources list')")
    .option("--json", "Output as JSON")
    .action(async (opts: Selection & { all?: boolean; json?: boolean }) => {
      const cfg = loadConfig();
      const api = requireSourcesApi(cfg);
      if (opts.all) {
        await printList(api, opts);
        return;
      }
      const { source, target } = await selectSource(api, cfg, opts);
      if (opts.json) {
        printResult(source, opts);
        return;
      }
      printSourceStatus(source, target);
    });
}

function listCommand(): Command {
  return new Command("list")
    .description(
      "Every connection this login sees: yours, and the org's that read raw files. What each reads, and how far it got",
    )
    .option("--json", "Output as JSON")
    .action(async (opts: { json?: boolean }) => {
      await printList(requireSourcesApi(loadConfig()), opts);
    });
}

async function printList(api: SourcesApi, opts: { json?: boolean }): Promise<void> {
  const sources = await api.list();
  if (opts.json) {
    printResult({ sources }, opts);
    return;
  }
  if (sources.length === 0) {
    console.log(
      "Nothing connected. 'dosu sources setup' ships this machine's sessions to the org's session store.",
    );
    return;
  }
  printTable(
    ["NAME", "URL", "FOLDER", "RAW FILES", "LAST READ", "STATE", "ID"],
    sources.map((s) => [
      truncate(s.name, 32),
      truncate(s.url, 40),
      s.owner ? `owners/${s.owner}/` : "—",
      rawSummary(s),
      lastRead(s) ? formatAge(lastRead(s) as string) : "never",
      sourceState(s),
      s.id,
    ]),
  );
}

/** The raw files a connection converts, in a few words. */
function rawSummary(s: SourceStatus): string {
  if (!s.scan_raw) return "—";
  if (s.pending || !s.files) return "waiting for files";
  return `${plural(s.files, "file")} · ${plural(s.sessions ?? 0, "session")}${s.agent ? ` (${s.agent})` : ""}`;
}

/** The later of the folder's last read and the raw files' last scan. */
function lastRead(s: SourceStatus): string | null {
  const times = [s.last_synced_at, s.raw_synced_at].filter((t): t is string => Boolean(t));
  return times.sort().at(-1) ?? null;
}

function sourceState(s: SourceStatus): string {
  if (!s.enabled) return "disabled";
  if (s.last_error) return `error ×${s.error_count}`;
  if (s.raw_error) return `raw error ×${s.raw_error_count ?? 1}`;
  if (s.pending) return "waiting for files";
  return "ok";
}

function printSourceStatus(s: SourceStatus, target?: SessionTarget, now: Date = new Date()): void {
  const failing = Boolean(s.last_error || s.raw_error);
  const dot = !s.enabled ? pc.dim("○") : failing ? pc.yellow("●") : pc.green("●");
  console.log(`${dot} ${s.name} ${pc.dim(`(${s.id})`)}`);
  console.log(`  Bucket:     ${target ? `${target.name} → ` : ""}${s.url}`);
  if (s.owner) {
    console.log(
      `  Folder:     owners/${s.owner}/ · ${
        s.last_synced_at
          ? `read ${formatAge(s.last_synced_at, now)} · ${s.last_sync_processed} processed · ${plural(s.last_sync_remaining, "change")} behind`
          : "not read yet"
      }`,
    );
    console.log(
      `  Cursor:     ${s.cursor ?? "start of changes/"} · re-reads ${s.lag_seconds}s of lag`,
    );
  } else {
    console.log("  Folder:     none; only the raw files are read");
  }
  if (s.scan_raw) {
    const files = s.recent_files ?? [];
    const counts: Record<string, number> = {};
    for (const f of files) counts[f.agent ?? "unknown"] = (counts[f.agent ?? "unknown"] ?? 0) + 1;
    const formats = s.agent
      ? `all read as ${s.agent}`
      : files.length > 0
        ? `recent: ${formatCounts(counts)}`
        : "detected per file";
    console.log(
      `  Raw files:  ${
        s.files ? `${plural(s.files, "file")} · ${plural(s.sessions ?? 0, "session")}` : "none yet"
      } · ${formats}`,
    );
    if (s.raw_synced_at) {
      console.log(
        `  Last scan:  ${formatAge(s.raw_synced_at, now)} · ${s.raw_listed ?? 0} listed · ${s.raw_imported ?? 0} imported · ${s.raw_remaining ?? 0} remaining`,
      );
    }
  } else {
    console.log("  Raw files:  not read by this connection");
  }
  if (s.pending) console.log(pc.dim("  Waiting for files: Dosu checks every 5 minutes."));
  if (!s.enabled) {
    console.log(
      pc.yellow(
        "  Disabled: you moved to another folder, or Dosu stopped reading it. 'dosu sources setup' enrolls again.",
      ),
    );
  }
  if (s.last_error) {
    console.log(pc.yellow(`  Last error: ${s.last_error} (${s.error_count} in a row)`));
  }
  if (s.raw_error) {
    console.log(pc.yellow(`  Raw error:  ${s.raw_error} (${s.raw_error_count ?? 1} in a row)`));
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
  const recentFiles = s.recent_files ?? [];
  if (recentFiles.length > 0) {
    console.log("  Recent files:");
    for (const f of recentFiles.slice(0, 10)) {
      const detail = f.detail ? ` ${pc.dim(`· ${truncate(f.detail, 60)}`)}` : "";
      console.log(
        `    ${formatAge(f.imported_at, now).padEnd(10)} ${(f.agent ?? "unknown").padEnd(18)} ${f.outcome.padEnd(10)} ${truncate(f.key, 48)}${detail}`,
      );
    }
  }
}

// --- sync --------------------------------------------------------------------

function syncCommand(): Command {
  return selectionOptions(
    new Command("sync").description(
      "Ask Dosu to read a connection now (its folder and raw files) instead of at the next interval",
    ),
  )
    .option("--json", "Output as JSON")
    .action(async (opts: Selection & { json?: boolean }) => {
      const cfg = loadConfig();
      const api = requireSourcesApi(cfg);
      const { source } = await selectSource(api, cfg, opts);
      const queued = await api.sync(source.id);
      if (opts.json) {
        printResult(queued, opts);
        return;
      }
      console.log(
        `${pc.green("✓")} Read queued for "${source.name}" (${source.url}); 'dosu sources status' shows what it read.`,
      );
    });
}

// --- disconnect --------------------------------------------------------------

function disconnectCommand(): Command {
  return selectionOptions(
    new Command("disconnect").description(
      "Forget a connection and the key Dosu held for it; sessions already in memory stay ('dosu redact' removes one)",
    ),
  )
    .option("-y, --yes", "Skip the confirmation")
    .option("--json", "Output as JSON")
    .action(async (opts: Selection & { yes?: boolean; json?: boolean }) => {
      const cfg = loadConfig();
      const api = requireSourcesApi(cfg);
      const { source, target } = await selectSource(api, cfg, opts);
      if (!opts.yes && !opts.json) {
        const ok = await confirm({
          message: `Disconnect "${source.name}" (${source.url})? Dosu stops reading it and drops its key; the bucket itself is untouched.`,
          initialValue: false,
        });
        if (isCancel(ok) || !ok) {
          console.log("Cancelled.");
          return;
        }
      }
      await api.disconnect(source.id);
      if (target) rememberSourceId(target, undefined);
      if (opts.json) {
        printResult({ id: source.id, disconnected: true }, opts);
        return;
      }
      console.log(
        `${pc.green("✓")} "${source.name}" disconnected${target ? `; ${target.name} is an archive again` : ""}.`,
      );
    });
}
