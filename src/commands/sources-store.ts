/** `dosu sources store`: the org's session store, the only place sessions go. An org admin says
 * once where the org keeps its sessions and gives Dosu its read key (`setup`; for a bucket, Dosu
 * looks first and the admin confirms or names the raw files' format); each member's `dosu setup`
 * then enrolls for their own folder (`join` does it again by hand), and `status` shows the store
 * and, to an admin, who has enrolled. */

import { Command } from "commander";
import pc from "picocolors";
import { CliUsageError } from "../cli/errors";
import { loadConfig } from "../config/config";
import { requireStoreApi, type SessionStore, SourcesApiError, sourcesApi } from "../sources/api";
import { parseAgent } from "../sources/bucket";
import { describeStore, joinOrgStore, orgStore } from "../sources/store";
import { chooseStore, setStore, storeKindOf, storeNotes } from "../sources/store-setup";
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
  agent?: string;
  yes?: boolean;
  json?: boolean;
}

async function runStoreSetup(opts: StoreSetupOptions): Promise<void> {
  if (Boolean(opts.readAccessKeyId) !== Boolean(opts.readSecretAccessKey)) {
    throw new CliUsageError("--read-access-key-id and --read-secret-access-key go together");
  }
  const kind = storeKindOf(opts);
  const agent = parseAgent(opts.agent);
  const cfg = loadConfig();
  const api = requireStoreApi(cfg);
  const current = await orgStore(api);
  const sources = sourcesApi(cfg);
  const chosen = await chooseStore(
    {
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
      ...(opts.clearTokenSecret ? { clearTokenSecret: true } : {}),
      ...(agent ? { agent } : {}),
      ...(opts.yes || opts.json ? { yes: true } : {}),
    },
    {
      ...(sources ? { sources } : {}),
      ...(current ? { current } : {}),
      say: (line) => {
        if (!opts.json) console.log(line);
      },
    },
  );
  if (!chosen) {
    console.log("Cancelled; the org's session store is unchanged.");
    return;
  }
  const store = await setStore(api, chosen.body);
  if (opts.json) {
    printResult(store, opts);
    return;
  }
  console.log(`${pc.green("✓")} The org's sessions go to ${describeStore(store)}.`);
  for (const note of storeNotes(store)) console.log(pc.dim(`  ${note}`));
}

function setupCommand(): Command {
  return new Command("setup")
    .description(
      "Set where the org's sessions live (org admins): Dosu's sessiondb (--hosted), the org's sessiondb server (--server, with the bucket it writes), or the org's bucket (--bucket), which members write directly and other tools (Datadog, CI, scripts) can drop raw logs in. Dosu gets a READ-ONLY key to the bucket and says what is there before the store is set (--agent names the raw files' format instead of detecting it per file); members never see that key. Anything written into the bucket reaches the org's memory, so a write key to it can add to that memory. Every member's 'dosu setup' then asks whether their machine ships there",
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
      "--agent <name>",
      "A bucket store: the format of every raw file other tools drop in it, overriding Dosu's per-file detection (claude-code, cursor, codex, opencode, pi, gemini-cli, atif, datadog-trajectory, trajectory)",
    )
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
    .action(runStoreSetup);
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
      if (store.kind === "bucket" && store.raw_source_id) {
        console.log(
          pc.dim(
            `  raw logs other tools drop in it: ${store.raw_agent ? `read as ${store.raw_agent}` : "each file's format detected"}`,
          ),
        );
      }
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
