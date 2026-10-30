/** `dosu redact`: remove a shipped session from the sessiondb server (its trace and raw objects
 * become a tombstone), or with `--dosu` from Dosu memory (the backend's session redaction).
 * Sessions are named the way the hooks name them, `<harness>:<id>` (`claude:abc…`); the server
 * keys them by trajectory source (`claude-code`), and either spelling is accepted. */

import { Command } from "commander";
import pc from "picocolors";
import { CliUsageError } from "../cli/errors";
import { type Config, loadConfig, MODE_OSS } from "../config/config";
import { getBackendURL, isAbsoluteHttpUrl } from "../config/constants";
import type { ServerTarget } from "../config/schema";
import { configuredTargets, selectTarget } from "../config/targets";
import { trajectorySourceOf } from "../sessions/start";
import { serverClient } from "../sources/server-client";
import { confirm, isCancel } from "../tui/prompts";
import { printResult } from "./output";

export function storeCommands(): Command[] {
  return [redactCommand()];
}

// --- shared ------------------------------------------------------------------

interface StoreSelection {
  target?: string;
}

/** The server `redact` works against: `--target`, else the default, else the only one. */
function selectServer(cfg: Config, selection: StoreSelection): ServerTarget {
  let target: ServerTarget | undefined;
  try {
    target = selectTarget(cfg, selection.target);
  } catch (err) {
    throw new CliUsageError(err instanceof Error ? err.message : String(err));
  }
  if (!target) {
    throw new CliUsageError(
      "no sessiondb server configured: run 'dosu setup' or 'dosu sources setup --server <url> --token <token>'",
    );
  }
  return target;
}

/** `<harness>:<id>` → the agent the server keys by, and the session id. */
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

const targetOptions = (cmd: Command): Command =>
  cmd.option("--target <name>", "Which configured server (default: the default, or the only one)");

// --- redact --------------------------------------------------------------------

function redactCommand(): Command {
  const cmd = new Command("redact")
    .description(
      "Remove a shipped session from the server (its trace and raw objects become a tombstone), or with --dosu from Dosu memory and the memories built from it",
    )
    .argument("<session>", "<harness>:<session-id>")
    .option("--dosu", "Redact from Dosu memory instead of the server")
    .option("--yes", "Skip the confirmation")
    .option("--json", "Output as JSON")
    .action(
      async (
        ref: string,
        opts: StoreSelection & { dosu?: boolean; yes?: boolean; json?: boolean },
      ) => {
        const cfg = loadConfig();
        const { sessionId, agent } = parseSessionRef(ref);
        const toDosu = opts.dosu === true || configuredTargets(cfg).length === 0;
        const where = toDosu ? "Dosu" : selectServer(cfg, opts).name;
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
          : await redactOnServer(cfg, opts, { agent, sessionId });
        if (opts.json) {
          printResult({ session: ref, target: where, ...result }, opts);
          return;
        }
        console.log(`Redacted ${ref} from ${where}: ${result.summary}`);
      },
    );
  return targetOptions(cmd);
}

async function redactOnServer(
  cfg: Config,
  selection: StoreSelection,
  session: { agent: string; sessionId: string },
): Promise<{ summary: string; removed: number }> {
  const target = selectServer(cfg, selection);
  const result = await serverClient(target).tombstone(session.agent, session.sessionId);
  if (!result) {
    throw new CliUsageError(
      `session ${session.agent}:${session.sessionId} is not on ${target.name}`,
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
    throw new CliUsageError("not logged in to Dosu: run 'dosu setup'");
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
