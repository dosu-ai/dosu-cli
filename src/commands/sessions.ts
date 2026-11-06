/** `dosu sessions push`: send the agent session files named to a sessiondb server, from a machine
 * nobody signs in on (a cloud agent's runner, CI). The server is DOSU_SESSIONDB_URL with
 * DOSU_SESSIONDB_TOKEN, else a configured target. It sends only what it is handed, never what it
 * finds on the machine: it ships past the sync's scope and incognito settings, so choosing the
 * files is the caller's (a runner gives each task its own agent directory and names what is in
 * it). Each one goes through the shipper a sync uses (shipper/runner.ts), so the server
 * normalizes, redacts, and judges it the same way. */

import { readFileSync } from "node:fs";
import { basename } from "node:path";
import { Command } from "commander";
import pc from "picocolors";
import { CliUsageError } from "../cli/errors";
import { loadConfig } from "../config/config";
import { type AgentSession, type SessionHarness, sessionAtPath } from "../sessions/scan";
import { createShipStep } from "../shipper/runner";
import { selectTarget } from "../shipper/select";
import { createServerTarget, type Target } from "../shipper/target";
import { envServer } from "../sources/env-server";
import type { ShipSessionResult } from "../sync/sync";

type FileHarness = Extract<SessionHarness, "claude" | "codex" | "cursor">;

function rowOf(line: string): Record<string, unknown> | null {
  try {
    const value: unknown = JSON.parse(line);
    return typeof value === "object" && value !== null ? (value as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

/** Which agent wrote the session file, from the first row only one of them writes: a Codex
 * `{ type, payload }` line, a Claude Code `{ type: "user" | "assistant", message }` row, or a
 * Cursor `{ role, message }` row. A runner keeps session files anywhere, so the content decides,
 * not the path. */
function harnessOf(transcript: string): FileHarness | null {
  for (const line of transcript.split("\n")) {
    const row = rowOf(line);
    if (!row) continue;
    if (typeof row.type === "string" && typeof row.payload === "object") return "codex";
    if (typeof row.message !== "object") continue;
    if (row.type === "user" || row.type === "assistant") return "claude";
    if (row.type === undefined && (row.role === "user" || row.role === "assistant")) {
      return "cursor";
    }
  }
  return null;
}

/** The session in a file the caller named, or why it is not one. */
function sessionOfFile(path: string): AgentSession | string {
  let transcript: string;
  try {
    transcript = readFileSync(path, "utf8");
  } catch (err) {
    return `cannot read the file (${(err as NodeJS.ErrnoException).code ?? "error"})`;
  }
  const harness = harnessOf(transcript);
  if (!harness) return "not a Claude Code, Codex, or Cursor session file";
  // Session files are named by their session id, as the scanner names them; a Claude Code file
  // in its agent's layout is read as the scan reads it (a subagent's names its session).
  const session = sessionAtPath(harness, basename(path).replace(/\.jsonl$/, ""), path);
  return session ?? "cannot read the file";
}

/** The server the environment names, else the configured one `--target` (or the default)
 * names. Throws when neither gives one. */
function pushTarget(env: NodeJS.ProcessEnv, name: string | undefined): Target {
  const server = name === undefined ? envServer(env) : undefined;
  if (server) return createServerTarget({ name: "env", ...server });
  const target = selectTarget(loadConfig(), { target: name });
  if (!target) {
    throw new CliUsageError(
      "no sessiondb server to push to: set DOSU_SESSIONDB_URL and DOSU_SESSIONDB_TOKEN, or run 'dosu sources setup'",
    );
  }
  return target;
}

/** One line for a session the shipper settled without sending, or null for one it sent or could
 * not send. */
function skippedLine(result: ShipSessionResult): string | null {
  switch (result.outcome) {
    case "trivial":
      return "skipped: too short to learn from";
    case "incognito":
      return "skipped: incognito";
    case "unsupported":
      return `skipped: ${result.message ?? "the server cannot read this session yet"}`;
    default:
      return null;
  }
}

/** Why the server did not take a session it was sent. */
function failureOf(result: ShipSessionResult): string {
  if (result.outcome !== "rejected") return `not sent: ${result.message ?? "unknown error"}`;
  const status = result.httpStatus !== undefined ? ` (HTTP ${result.httpStatus})` : "";
  return `the server refused the session${status}: ${result.message ?? "no reason given"}`;
}

export function sessionsCommand(): Command {
  const cmd = new Command("sessions").description("Send coding-agent sessions to sessiondb");

  cmd
    .command("push")
    .description("Push agent session files to a sessiondb server (no sign-in)")
    .argument("<files...>", "Claude Code, Codex, or Cursor session files (.jsonl)")
    .option("--target <name>", "A configured server, instead of DOSU_SESSIONDB_URL")
    .addHelpText(
      "after",
      "\nEnvironment:\n" +
        "  DOSU_SESSIONDB_URL    the sessiondb server (https://...); with DOSU_SESSIONDB_TOKEN,\n" +
        "                        used instead of a configured target\n" +
        "  DOSU_SESSIONDB_TOKEN  a token the server accepts\n" +
        "  DOSU_PROJECT          the project the sessions belong to, when their checkout's origin\n" +
        "                        doesn't name it\n\n" +
        "The server redacts each session before storing it. Sessions too short to learn from, and\n" +
        "those taken off the record with /dosu-incognito, are skipped.",
    )
    .action(async (files: string[], opts: { target?: string }) => {
      const target = pushTarget(process.env, opts.target);
      const sessions: AgentSession[] = [];
      for (const file of files) {
        const session = sessionOfFile(file);
        if (typeof session === "string") {
          console.error(pc.red(`✗ ${file}: ${session}`));
          process.exitCode = 1;
        } else {
          sessions.push(session);
        }
      }
      // The pusher's environment is its agents' (a runner gives both the same one), so the
      // DOSU_PROJECT it sets names their project.
      const ship = createShipStep({ target, agentEnv: process.env });
      // One session at a time: one that can't reach the server doesn't keep the rest from trying.
      for (const session of sessions) {
        const [result] = await ship([session]);
        if (!result) continue;
        const skipped = skippedLine(result);
        if (result.outcome === "shipped") {
          console.log(`${pc.green("✓")} ${session.path}`);
        } else if (skipped) {
          console.log(`${pc.dim("-")} ${session.path}: ${skipped}`);
        } else {
          console.error(pc.red(`✗ ${session.path}: ${failureOf(result)}`));
          process.exitCode = 1;
        }
      }
    });

  return cmd;
}
