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
import { envServer } from "../sources/env-server";
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

/** A server `redact` can reach: a configured target, or the one the environment names. */
type RedactServer = Pick<ServerTarget, "name" | "url" | "token">;

/** The server `redact` works against: `--target`, else DOSU_SESSIONDB_URL with
 * DOSU_SESSIONDB_TOKEN (as `sessions push` ships to), else the default, else the only one;
 * undefined when there is none. */
function selectServer(cfg: Config, selection: StoreSelection): RedactServer | undefined {
  const env = selection.target === undefined ? envServer(process.env) : undefined;
  if (env) return { name: "env", ...env };
  try {
    return selectTarget(cfg, selection.target);
  } catch (err) {
    throw new CliUsageError(err instanceof Error ? err.message : String(err));
  }
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
        const server =
          opts.dosu === true || (configuredTargets(cfg).length === 0 && opts.target !== undefined)
            ? undefined
            : selectServer(cfg, opts);
        const where = server ? server.name : "Dosu";
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
        const result = server
          ? await redactOnServer(server, { agent, sessionId })
          : await redactFromDosu(cfg, sessionId);
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
  target: RedactServer,
  session: { agent: string; sessionId: string },
): Promise<{ summary: string; removed: number }> {
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
