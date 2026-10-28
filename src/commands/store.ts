/** Looking at what was shipped: `dosu get`, `dosu export`, `dosu changes` read a bucket or folder
 * target through `@dosu/sessionstorage`; `dosu redact` removes a session from a store target
 * (tombstone) or from Dosu (the backend's session redaction). Sessions are named the way the
 * hooks name them, `<harness>:<id>` (`claude:abc…`); the store keys them by trajectory source
 * (`claude-code`), and either spelling is accepted. */

import {
  type ChangeEntry,
  getSession,
  getTrace,
  readChanges,
  type SessionMetadata,
  type Store,
  type Trace,
  tombstone,
  trajectorySourceOf,
} from "@dosu/sessionstorage";
import { Command } from "commander";
import pc from "picocolors";
import { CliUsageError } from "../cli/errors";
import { type Config, loadConfig, MODE_OSS } from "../config/config";
import { getBackendURL, isAbsoluteHttpUrl } from "../config/constants";
import type { BucketTarget } from "../config/schema";
import { configuredTargets, openStore, resolveBucketTarget } from "../config/targets";
import { confirm, isCancel } from "../tui/prompts";
import { printResult, printTable, truncate } from "./output";

export function storeCommands(): Command[] {
  return [getCommand(), exportCommand(), changesCommand(), redactCommand()];
}

// --- shared ------------------------------------------------------------------

interface StoreSelection {
  target?: string;
  owner?: string;
}

/** The bucket target a read command works against: `--target`, else the config's default when
 * it is a bucket target, else the only configured one. Dosu is not a store to read. */
function selectBucketTarget(cfg: Config, selection: StoreSelection): BucketTarget {
  const named =
    selection.target ?? (cfg.default_target !== "dosu" ? cfg.default_target : undefined);
  if (named !== undefined) return resolveBucketTarget(cfg, named, { owner: selection.owner });
  const targets = configuredTargets(cfg);
  if (targets.length === 1) return targets[0] as BucketTarget;
  if (targets.length === 0) {
    throw new CliUsageError(
      "no bucket target to read: pass --target <name|url> (and --owner for a URL), or add one to config.json",
    );
  }
  throw new CliUsageError(
    `several targets are configured (${targets.map((t) => t.name).join(", ")}): pass --target <name>`,
  );
}

function openSelected(selection: StoreSelection): {
  store: Store & { url: string };
  target: BucketTarget;
} {
  const target = selectBucketTarget(loadConfig(), selection);
  return { store: openStore(target), target };
}

/** `<harness>:<id>` → the agent the store keys by, and the session id. */
function parseSessionRef(ref: string): { agent: string; sessionId: string; harness: string } {
  const at = ref.indexOf(":");
  if (at <= 0 || at === ref.length - 1) {
    throw new CliUsageError(
      `expected <harness>:<session-id> (for example claude:abc123), got '${ref}'`,
    );
  }
  const harness = ref.slice(0, at);
  const sessionId = ref.slice(at + 1);
  return { harness, sessionId, agent: trajectorySourceOf(harness) ?? harness };
}

async function loadSession(
  store: Store,
  owner: string,
  ref: string,
): Promise<{ metadata: SessionMetadata; trace: Trace | null }> {
  const { agent, sessionId } = parseSessionRef(ref);
  const metadata = await getSession(store, owner, agent, sessionId);
  if (!metadata) throw new CliUsageError(`session ${ref} is not in this target (owner ${owner})`);
  const trace = metadata.head
    ? await getTrace(store, owner, metadata.archive_id, metadata.head)
    : null;
  return { metadata, trace };
}

const targetOptions = (cmd: Command): Command =>
  cmd
    .option("--target <name|url>", "A configured target's name, or an s3:// / r2:// / file:// URL")
    .option("--owner <id>", "Owner id for an ad-hoc --target URL");

// --- get -----------------------------------------------------------------------

function getCommand(): Command {
  const cmd = new Command("get")
    .description("Show a shipped session: its metadata and current trace")
    .argument("<session>", "<harness>:<session-id>, as the hooks name it (claude:abc123)")
    .option("--json", "Output as JSON ({ metadata, trace })")
    .action(async (ref: string, opts: StoreSelection & { json?: boolean }) => {
      const { store, target } = openSelected(opts);
      const { metadata, trace } = await loadSession(store, target.owner, ref);
      if (opts.json) {
        printResult({ metadata, trace }, opts);
        return;
      }
      printSession(metadata, trace, target);
    });
  return targetOptions(cmd);
}

function printSession(metadata: SessionMetadata, trace: Trace | null, target: BucketTarget): void {
  const row = (label: string, value: string | undefined) => {
    if (value !== undefined) console.log(`  ${label.padEnd(10)} ${value}`);
  };
  console.log(pc.bold(`${metadata.agent}:${metadata.session_id}`));
  row("target", `${target.name} (${target.url})`);
  row("owner", metadata.owner);
  row("archive", metadata.archive_id);
  row("status", metadata.status);
  row("project", metadata.project);
  row("branch", metadata.branch);
  row("parent", metadata.parent_session_id);
  row("created", metadata.created_at);
  row("updated", metadata.updated_at);
  row("head", metadata.head);
  row("traces", String(metadata.traces.length));
  row("raw parts", String(metadata.raw.length));
  if (!trace) {
    console.log(pc.dim(metadata.status === "redacted" ? "\n(redacted: no trace)" : "\n(no trace)"));
    return;
  }
  console.log(`\n${pc.bold("Trace")} ${trace.events.length} events`);
  for (const event of trace.events.slice(0, 12)) {
    const label = event.tool_name ? `${event.role}:${event.tool_name}` : event.role;
    console.log(`  ${pc.dim(label.padEnd(10))} ${truncate(event.text.replaceAll("\n", " "), 100)}`);
  }
  if (trace.events.length > 12) {
    console.log(
      pc.dim(`  … ${trace.events.length - 12} more; 'dosu export' writes the whole trace`),
    );
  }
}

// --- export --------------------------------------------------------------------

function exportCommand(): Command {
  const cmd = new Command("export")
    .description("Write a shipped session's current trace as JSON (sessionstorage/trace/1)")
    .argument("<session>", "<harness>:<session-id>")
    .option("--out <path>", "Write to a file instead of stdout")
    .action(async (ref: string, opts: StoreSelection & { out?: string }) => {
      const { store, target } = openSelected(opts);
      const { metadata, trace } = await loadSession(store, target.owner, ref);
      if (!trace) {
        throw new CliUsageError(
          `session ${ref} has no trace to export${metadata.status === "redacted" ? " (redacted)" : ""}`,
        );
      }
      const json = JSON.stringify(trace, null, 2);
      if (opts.out) {
        const { writeFileSync } = await import("node:fs");
        writeFileSync(opts.out, `${json}\n`);
        console.error(`Wrote ${trace.events.length} events to ${opts.out}`);
        return;
      }
      process.stdout.write(`${json}\n`);
    });
  return targetOptions(cmd);
}

// --- changes -------------------------------------------------------------------

function changesCommand(): Command {
  const cmd = new Command("changes")
    .description("List a target's change feed: traces published, sessions redacted")
    .option("--since <iso>", "Start from this time (ISO 8601)")
    .option("--after <key>", "Continue after this change key (the cursor a previous page printed)")
    .option("--limit <n>", "Page size", (v: string) => Number.parseInt(v, 10), 50)
    .option("--json", "Output as JSON")
    .action(
      async (
        opts: StoreSelection & { since?: string; after?: string; limit: number; json?: boolean },
      ) => {
        if (!Number.isInteger(opts.limit) || opts.limit <= 0) {
          throw new CliUsageError("--limit must be a positive integer");
        }
        const { store, target } = openSelected(opts);
        const page = await readChanges(store, target.owner, {
          since: opts.since,
          after: opts.after,
          limit: opts.limit,
        });
        if (opts.json) {
          printResult(page, opts);
          return;
        }
        if (page.entries.length === 0) {
          console.log(
            pc.dim(`No changes${opts.since ? ` since ${opts.since}` : ""} in ${target.name}.`),
          );
          return;
        }
        printTable(
          ["At", "Kind", "Session", "Trace"],
          page.entries.map(({ entry }) => changeRow(entry)),
        );
        if (page.truncated && page.cursor) {
          console.log(pc.dim(`\nMore: dosu changes --after ${page.cursor}`));
        }
      },
    );
  return targetOptions(cmd);
}

function changeRow(entry: ChangeEntry): string[] {
  const session = truncate(entry.session_id, 24);
  const trace = entry.content_hash ? entry.content_hash.slice(0, 12) : "-";
  const kind =
    entry.kind === "published" && entry.continuation
      ? `published (+${entry.continuation.from_record})`
      : entry.kind;
  return [entry.at, kind, session, trace];
}

// --- redact --------------------------------------------------------------------

function redactCommand(): Command {
  const cmd = new Command("redact")
    .description(
      "Remove a shipped session from its target: a bucket target drops its trace and raw objects (tombstone); Dosu redacts it and the memories built from it",
    )
    .argument("<session>", "<harness>:<session-id>")
    .option("--yes", "Skip the confirmation")
    .option("--json", "Output as JSON")
    .action(async (ref: string, opts: StoreSelection & { yes?: boolean; json?: boolean }) => {
      const cfg = loadConfig();
      const named = opts.target ?? cfg.default_target;
      const { sessionId, agent } = parseSessionRef(ref);
      const toDosu =
        named === "dosu" || (named === undefined && configuredTargets(cfg).length === 0);
      const where = toDosu ? "Dosu" : selectBucketTarget(cfg, opts).name;
      if (!opts.yes) {
        const ok = await confirm({
          message: `Redact ${ref} from ${where}? This cannot be undone.`,
          initialValue: false,
        });
        if (isCancel(ok) || !ok) {
          console.log(pc.dim("Kept."));
          return;
        }
      }
      const result = toDosu
        ? await redactFromDosu(cfg, sessionId)
        : await redactFromStore(cfg, opts, { agent, sessionId });
      if (opts.json) {
        printResult({ session: ref, target: where, ...result }, opts);
        return;
      }
      console.log(`Redacted ${ref} from ${where}: ${result.summary}`);
    });
  return targetOptions(cmd);
}

async function redactFromStore(
  cfg: Config,
  selection: StoreSelection,
  session: { agent: string; sessionId: string },
): Promise<{ summary: string; removed: number }> {
  const target = selectBucketTarget(cfg, selection);
  const result = await tombstone({
    store: openStore(target),
    owner: target.owner,
    agent: session.agent,
    session_id: session.sessionId,
  });
  if (!result) {
    throw new CliUsageError(
      `session ${session.agent}:${session.sessionId} is not in ${target.name}`,
    );
  }
  return {
    summary: `${result.removed} object${result.removed === 1 ? "" : "s"} removed`,
    ...result,
  };
}

interface DosuRedaction {
  traces_redacted: number;
  episodes_redacted: number;
  memories_deleted: number;
  memories_rolled_back: number;
}

async function redactFromDosu(
  cfg: Config,
  sessionId: string,
): Promise<{ summary: string } & DosuRedaction> {
  const account = cfg.active_account?.target;
  const backendUrl = getBackendURL();
  if (
    cfg.mode === MODE_OSS ||
    !account?.api_key ||
    !account.org_id ||
    !isAbsoluteHttpUrl(backendUrl)
  ) {
    throw new CliUsageError(
      "not logged in to Dosu: run 'dosu setup', or pass --target for a bucket target",
    );
  }
  const url = `${backendUrl.replace(/\/$/, "")}/v1/memory/browse/sessions/${encodeURIComponent(sessionId)}/redact?org=${encodeURIComponent(account.org_id)}`;
  const response = await fetch(url, {
    method: "POST",
    headers: { "X-Dosu-API-Key": account.api_key },
  });
  if (response.status === 404) {
    throw new CliUsageError(
      `session ${sessionId} is not in Dosu (or none of its traces are yours)`,
    );
  }
  if (!response.ok) throw new Error(`redact failed: HTTP ${response.status}`);
  const body = (await response.json()) as DosuRedaction;
  return {
    summary: `${body.traces_redacted} trace${body.traces_redacted === 1 ? "" : "s"}, ${body.episodes_redacted} episode${body.episodes_redacted === 1 ? "" : "s"}, ${body.memories_deleted} memor${body.memories_deleted === 1 ? "y" : "ies"} deleted`,
    ...body,
  };
}
