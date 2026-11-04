/** `dosu imports`: a bucket of raw session files Dosu imports for the org. For sessions that
 * already live in a store of your own, in a format of your own (a coding agent's logs synced
 * to S3, a Datadog Trajectory capture), that you will not copy into a sessiondb layout: Dosu
 * reads the bucket, runs each file through the same redaction and normalization the CLI does,
 * and keeps the result in its own store. `connect` registers one, `status` shows what Dosu has
 * imported of it, `sync` runs it now, `disconnect` forgets it. Org-level: everyone in the org
 * sees the sessions; the connector (or an admin) disconnects. */

import { Command } from "commander";
import pc from "picocolors";
import { CliUsageError } from "../cli/errors";
import { loadConfig } from "../config/config";
import {
  type ConnectImportRequest,
  IMPORT_AGENTS,
  type ImportAgent,
  type ImportStatus,
  type ImportsApi,
  requireImportsApi,
  SourcesApiError,
} from "../sources/api";
import { confirm, isCancel } from "../tui/prompts";
import { formatAge, printResult, printTable, truncate } from "./output";
import { readCredentials } from "./sources";

export function importsCommand(): Command {
  const cmd = new Command("imports").description(
    "Buckets of raw session files (your agents' own logs, a Datadog capture) Dosu imports into memory for the org",
  );
  cmd.addCommand(connectCommand());
  cmd.addCommand(statusCommand());
  cmd.addCommand(syncCommand());
  cmd.addCommand(disconnectCommand());
  return cmd;
}

function isAgent(value: string): value is ImportAgent {
  return (IMPORT_AGENTS as readonly string[]).includes(value);
}

function parseCount(
  value: string | undefined,
  flag: string,
  min: number,
  max: number,
): number | undefined {
  if (value === undefined) return undefined;
  const n = Number.parseInt(value, 10);
  if (!Number.isFinite(n) || n < min || n > max) {
    throw new CliUsageError(`${flag} must be a whole number from ${min} to ${max}, got '${value}'`);
  }
  return n;
}

/** The import an id or name points at; with exactly one connected, no selector is needed. */
async function requireImport(api: ImportsApi, selector: string | undefined): Promise<ImportStatus> {
  const imports = await api.list();
  if (selector) {
    const found = imports.find((i) => i.id === selector || i.name === selector);
    if (!found) {
      throw new CliUsageError(
        `no import '${selector}' in this org; 'dosu imports status --all' lists them`,
      );
    }
    return found;
  }
  if (imports.length === 1) return imports[0] as ImportStatus;
  if (imports.length === 0) {
    throw new CliUsageError("no imports connected; 'dosu imports connect' registers a bucket");
  }
  throw new CliUsageError(
    `${imports.length} imports connected; say which with --import <id or name> ('dosu imports status --all' lists them)`,
  );
}

// --- connect -----------------------------------------------------------------

function connectCommand(): Command {
  return new Command("connect")
    .description(
      "Register a bucket of raw session files: Dosu reads it (with the keys you give it here), normalizes each file, and imports new or grown files every few minutes",
    )
    .requiredOption(
      "--agent <name>",
      `Format of the files: ${IMPORT_AGENTS.join(", ")} (a Datadog Trajectory daemon writes datadog-trajectory)`,
    )
    .requiredOption("--bucket <name>", "The bucket")
    .option("--prefix <path>", "Key prefix the session files are under (default: the bucket root)")
    .option("--kind <s3|r2>", "Which kind of bucket (default: s3)")
    .option("--region <region>", "AWS region (s3)")
    .option("--account-id <id>", "Cloudflare account id (r2)")
    .option("--endpoint <url>", "S3-compatible endpoint, when not AWS's or R2's own")
    .option("--access-key-id <id>", "Key Dosu reads the bucket with (read-only is enough)")
    .option("--secret-access-key <secret>", "Secret for --access-key-id")
    .option("--session-token <token>", "Session token, for temporary credentials")
    .option(
      "--read-credentials-stdin",
      "Read the key pair from stdin: JSON {access_key_id, secret_access_key} or two lines",
    )
    .option("--name <name>", "How Dosu labels the import (default: the bucket URL and agent)")
    .option(
      "--shards <n>",
      "Spread the files over n parallel runs (1-64; raise for a store with thousands of sessions a day)",
    )
    .option(
      "--lookback-days <n>",
      "Of a layout with a day in the path (sessions/<date>/...), how many days back each run lists (default: 3)",
    )
    .option("--json", "Output as JSON")
    .action(
      async (opts: {
        agent: string;
        bucket: string;
        prefix?: string;
        kind?: string;
        region?: string;
        accountId?: string;
        endpoint?: string;
        accessKeyId?: string;
        secretAccessKey?: string;
        sessionToken?: string;
        readCredentialsStdin?: boolean;
        name?: string;
        shards?: string;
        lookbackDays?: string;
        json?: boolean;
      }) => {
        const api = requireImportsApi(loadConfig());
        if (!isAgent(opts.agent)) {
          throw new CliUsageError(
            `--agent must be one of ${IMPORT_AGENTS.join(", ")}, got '${opts.agent}'`,
          );
        }
        const kind = opts.kind ?? "s3";
        if (kind !== "s3" && kind !== "r2") {
          throw new CliUsageError(`--kind must be s3 or r2, got '${opts.kind}'`);
        }
        if (kind === "r2" && !opts.accountId && !opts.endpoint) {
          throw new CliUsageError("an r2 bucket needs --account-id or --endpoint");
        }
        const shards = parseCount(opts.shards, "--shards", 1, 64);
        const lookbackDays = parseCount(opts.lookbackDays, "--lookback-days", 1, 3650);
        const { credentials, from } = await readCredentials(opts);
        const prefix = (opts.prefix ?? "").replace(/^\/+|\/+$/g, "");
        const url = `${kind}://${opts.bucket}${prefix ? `/${prefix}` : ""}`;
        const body: Omit<ConnectImportRequest, "deployment_id"> = {
          agent: opts.agent,
          kind,
          bucket: opts.bucket,
          prefix,
          ...(opts.region ? { region: opts.region } : {}),
          ...(opts.accountId ? { account_id: opts.accountId } : {}),
          ...(opts.endpoint ? { endpoint: opts.endpoint } : {}),
          ...credentials,
          ...(opts.name ? { name: opts.name } : {}),
          ...(shards !== undefined ? { shards } : {}),
          ...(lookbackDays !== undefined ? { lookback_days: lookbackDays } : {}),
        };

        let imported: ImportStatus;
        try {
          imported = await api.connect(body);
        } catch (err) {
          if (err instanceof SourcesApiError && (err.status === 400 || err.status === 422)) {
            throw new CliUsageError(
              `Dosu could not import ${url} with the ${from} keys: ${err.message}`,
            );
          }
          if (err instanceof SourcesApiError && err.status === 409) {
            throw new CliUsageError(
              `${url} is already connected; 'dosu imports status --all' shows it`,
            );
          }
          if (err instanceof SourcesApiError && err.status === 404) {
            throw new CliUsageError(
              `${api.backendUrl} does not import session stores: ${err.message}`,
            );
          }
          throw err;
        }

        if (opts.json) {
          printResult(imported, opts);
          return;
        }
        const found = imported.files_found ?? 0;
        console.log(
          `${pc.green("✓")} Dosu can read ${imported.url}: ${found} ${imported.agent} file${found === 1 ? "" : "s"} on the first page${
            imported.dated_prefix ? `, laid out by day under ${imported.dated_prefix}` : ""
          }.`,
        );
        console.log(
          `${pc.green("✓")} Import "${imported.name}" connected (${imported.id}); keys from ${from}, encrypted at rest.`,
        );
        console.log(
          pc.dim(
            `  First run queued (${imported.shards} shard${imported.shards === 1 ? "" : "s"}); 'dosu imports status' shows what it imported, 'dosu imports sync' runs it again.`,
          ),
        );
      },
    );
}

// --- status ------------------------------------------------------------------

function statusCommand(): Command {
  return new Command("status")
    .description("What Dosu has imported of a bucket: files, sessions, the last run, errors")
    .option("--import <id or name>", "Which import (default: the only one)")
    .option("--all", "Every import in the org, one line each")
    .option("--json", "Output as JSON")
    .action(async (opts: { import?: string; all?: boolean; json?: boolean }) => {
      const api = requireImportsApi(loadConfig());
      if (opts.all) {
        const imports = await api.list();
        if (opts.json) {
          printResult({ imports }, opts);
          return;
        }
        if (imports.length === 0) {
          console.log("No imports connected. 'dosu imports connect' registers a bucket.");
          return;
        }
        printTable(
          ["NAME", "URL", "AGENT", "SESSIONS", "LAST RUN", "BEHIND", "STATE", "ID"],
          imports.map((i) => [
            i.name,
            truncate(i.url, 40),
            i.agent,
            String(i.sessions),
            i.last_imported_at ? formatAge(i.last_imported_at) : "never",
            String(i.last_run_remaining),
            importState(i),
            i.id,
          ]),
        );
        return;
      }
      const chosen = await requireImport(api, opts.import);
      const imported = await api.get(chosen.id);
      if (opts.json) {
        printResult(imported, opts);
        return;
      }
      printImportStatus(imported);
    });
}

function importState(i: ImportStatus): string {
  if (!i.enabled) return "disabled";
  if (i.last_error) return `error ×${i.error_count}`;
  return "ok";
}

function printImportStatus(i: ImportStatus, now: Date = new Date()): void {
  const dot = !i.enabled ? pc.dim("○") : i.last_error ? pc.yellow("●") : pc.green("●");
  console.log(`${dot} ${i.name} ${pc.dim(`(${i.id})`)}`);
  console.log(`  Bucket:     ${i.url} · ${i.agent}`);
  console.log(
    `  Imported:   ${i.sessions} session${i.sessions === 1 ? "" : "s"} from ${i.files} file${i.files === 1 ? "" : "s"}`,
  );
  console.log(
    `  Last run:   ${
      i.last_imported_at
        ? `${formatAge(i.last_imported_at, now)} · ${i.last_run_listed} listed, ${i.last_run_imported} imported`
        : "not yet"
    }`,
  );
  console.log(
    `  Behind:     ${i.last_run_remaining} file${i.last_run_remaining === 1 ? "" : "s"} · ${i.shards} shard${i.shards === 1 ? "" : "s"}${
      i.dated_prefix ? ` · last ${i.lookback_days} days of ${i.dated_prefix}` : ""
    }`,
  );
  if (!i.enabled) console.log(pc.yellow("  Disabled by Dosu; connect again to re-enable."));
  if (i.last_error) {
    console.log(pc.yellow(`  Last error: ${i.last_error} (${i.error_count} in a row)`));
  }
  const recent = i.recent ?? [];
  if (recent.length > 0) {
    console.log("  Recent:");
    for (const f of recent.slice(0, 10)) {
      const detail = f.detail ? ` ${pc.dim(`· ${truncate(f.detail, 60)}`)}` : "";
      console.log(
        `    ${formatAge(f.imported_at, now).padEnd(10)} ${f.outcome.padEnd(10)} ${truncate(f.key, 56)}${detail}`,
      );
    }
  }
}

// --- sync --------------------------------------------------------------------

function syncCommand(): Command {
  return new Command("sync")
    .description("Ask Dosu to import the bucket now instead of at the next interval")
    .option("--import <id or name>", "Which import (default: the only one)")
    .option("--json", "Output as JSON")
    .action(async (opts: { import?: string; json?: boolean }) => {
      const api = requireImportsApi(loadConfig());
      const chosen = await requireImport(api, opts.import);
      const queued = await api.sync(chosen.id);
      if (opts.json) {
        printResult(queued, opts);
        return;
      }
      console.log(
        `${pc.green("✓")} Import queued for "${chosen.name}" (${chosen.url}), ${queued.workflow_ids.length} shard${queued.workflow_ids.length === 1 ? "" : "s"}; 'dosu imports status' shows what it read.`,
      );
    });
}

// --- disconnect --------------------------------------------------------------

function disconnectCommand(): Command {
  return new Command("disconnect")
    .description(
      "Forget the bucket and the keys Dosu held for it; what was imported stays until the org's last import goes",
    )
    .option("--import <id or name>", "Which import (default: the only one)")
    .option("-y, --yes", "Skip the confirmation")
    .option("--json", "Output as JSON")
    .action(async (opts: { import?: string; yes?: boolean; json?: boolean }) => {
      const api = requireImportsApi(loadConfig());
      const chosen = await requireImport(api, opts.import);
      if (!opts.yes && !opts.json) {
        const ok = await confirm({
          message: `Disconnect "${chosen.name}" (${chosen.url})? Dosu stops importing it and drops its keys; the bucket itself is untouched.`,
          initialValue: false,
        });
        if (isCancel(ok) || !ok) {
          console.log("Cancelled.");
          return;
        }
      }
      await api.disconnect(chosen.id);
      if (opts.json) {
        printResult({ id: chosen.id, disconnected: true }, opts);
        return;
      }
      console.log(`${pc.green("✓")} "${chosen.name}" disconnected.`);
    });
}
