/** `dosu sessions push`: send agent session files to Dosu with an organization ingest key, from a
 * machine nobody signs in on (a cloud agent's runner, CI). Each file is normalized and redacted as
 * the signed-in shipper does it (shipper/normalize.ts). */

import { readFileSync } from "node:fs";
import { basename, isAbsolute } from "node:path";
import type { MetaRecord } from "@letta-ai/trajectory";
import { Command } from "commander";
import pc from "picocolors";
import { CommandError } from "../cli/command-error";
import { getBackendURL } from "../config/constants";
import { resolveProjectOfDir } from "../sessions/project";
import { githubSlugOfRepo, originRepoOfDir } from "../sessions/repo";
import type { AgentSession } from "../sessions/scan";
import { normalizeSessionRecords, trajectorySourceOf } from "../shipper/normalize";

/** The ingest API only queues work, but a long session is a large body. */
const REQUEST_TIMEOUT_MS = 60_000;

type FileHarness = "claude" | "codex" | "cursor";

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

/** Push one session file; the reason it was not pushed, or null. */
async function pushFile(path: string, key: string, backend: string): Promise<string | null> {
  let transcript: string;
  try {
    transcript = readFileSync(path, "utf8");
  } catch (err) {
    return `cannot read the file (${(err as NodeJS.ErrnoException).code ?? "error"})`;
  }
  const harness = harnessOf(transcript);
  if (!harness) return "not a Claude Code, Codex, or Cursor session file";
  // Session files are named by their session id, as the scanner names them.
  const id = basename(path).replace(/\.jsonl$/, "");
  const session: AgentSession = { id, harness, path, updated: new Date().toISOString() };
  const records = await normalizeSessionRecords(session);
  if (!records?.length) return "no conversation Dosu can read in it";
  // The meta record comes first: its working directory gives the session the same project key
  // and repository a signed-in sync would (sessions/project.ts).
  const cwd = (records[0] as MetaRecord).cwd;
  const dir = cwd && isAbsolute(cwd) ? cwd : null;
  const project = (dir && resolveProjectOfDir(dir)?.project) ?? "unknown";
  const repo = githubSlugOfRepo(dir && originRepoOfDir(dir));
  const body = JSON.stringify({
    records,
    metadata: {
      project,
      ...(repo ? { repo } : {}),
      agent: trajectorySourceOf(harness),
      session_id: id,
    },
  });
  try {
    const response = await fetch(`${backend}/v1/memory/ingest`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${key}` },
      body,
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
    return response.ok ? null : `Dosu refused the session (HTTP ${response.status})`;
  } catch (err) {
    return `could not reach Dosu: ${err instanceof Error ? err.message : err}`;
  }
}

export function sessionsCommand(): Command {
  const cmd = new Command("sessions").description("Send coding-agent sessions to Dosu");

  cmd
    .command("push")
    .description("Push agent session files to Dosu with an ingest key (no sign-in)")
    .argument("<files...>", "Claude Code, Codex, or Cursor session files (.jsonl)")
    .addHelpText(
      "after",
      "\nEnvironment:\n  DOSU_INGEST_KEY  Dosu ingest key (dxi_live_...); required\n\n" +
        "Each session is redacted before it is sent.",
    )
    .action(async (files: string[]) => {
      const key = process.env.DOSU_INGEST_KEY?.trim();
      if (!key) {
        throw new CommandError("INVALID_ARGUMENT", "DOSU_INGEST_KEY is not set", [
          "Set it to a Dosu ingest key (dxi_live_...) and run the command again.",
        ]);
      }
      const backend = getBackendURL().replace(/\/+$/, "");
      for (const file of files) {
        const failure = await pushFile(file, key, backend);
        if (failure) {
          console.error(pc.red(`✗ ${file}: ${failure}`));
          process.exitCode = 1;
        } else {
          console.log(`${pc.green("✓")} ${file}`);
        }
      }
    });

  return cmd;
}
