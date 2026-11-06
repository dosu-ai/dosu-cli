/** `dosu sessions push`: send the agent session files named to Dosu with an organization ingest
 * key, from a machine nobody signs in on (a cloud agent's runner, CI). It sends only what it is
 * handed, never what it finds on the machine: the key files sessions under the organization, past
 * the sync's scope and incognito settings, so choosing them is the caller's (a runner gives each
 * task its own agent directory and names what is in it). Each one goes through the shipper a
 * signed-in sync uses (shipper/runner.ts), so it is normalized, redacted, and judged the same way;
 * only the credential differs. */

import { readFileSync } from "node:fs";
import { basename } from "node:path";
import { Command } from "commander";
import pc from "picocolors";
import { CommandError } from "../cli/command-error";
import { type AgentSession, type SessionHarness, sessionAtPath } from "../sessions/scan";
import { createShipStep } from "../shipper/runner";
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

/** One line for a session the shipper settled without sending, or null for one it sent or could
 * not send. */
function skippedLine(result: ShipSessionResult): string | null {
  switch (result.outcome) {
    case "trivial":
      return "skipped: too short to learn from";
    case "incognito":
      return "skipped: incognito";
    case "unsupported":
      return `skipped: ${result.message ?? "Dosu cannot read this session yet"}`;
    default:
      return null;
  }
}

/** Why Dosu did not take a session it was sent. */
function failureOf(result: ShipSessionResult): string {
  return result.outcome === "rejected"
    ? `Dosu refused the session (HTTP ${result.httpStatus})`
    : `not sent: ${result.message ?? "unknown error"}`;
}

export function sessionsCommand(): Command {
  const cmd = new Command("sessions").description("Send coding-agent sessions to Dosu");

  cmd
    .command("push")
    .description("Push agent sessions to Dosu with an ingest key (no sign-in)")
    .argument("<files...>", "Claude Code, Codex, or Cursor session files (.jsonl)")
    .addHelpText(
      "after",
      "\nEnvironment:\n  DOSU_INGEST_KEY  Dosu ingest key (dxi_live_...); required\n" +
        "  DOSU_PROJECT     the project the sessions belong to, when their checkout's origin\n" +
        "                   doesn't name it\n\n" +
        "Each session is redacted before it is sent. Sessions too short to learn from, and those\n" +
        "taken off the record with /dosu-incognito, are skipped.",
    )
    .action(async (files: string[]) => {
      const key = process.env.DOSU_INGEST_KEY?.trim();
      if (!key) {
        throw new CommandError("INVALID_ARGUMENT", "DOSU_INGEST_KEY is not set", [
          "Set it to a Dosu ingest key (dxi_live_...) and run the command again.",
        ]);
      }
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
      const ship = createShipStep({ ingestKey: key, agentEnv: process.env });
      // One session at a time: one that can't reach Dosu doesn't keep the rest from trying.
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
