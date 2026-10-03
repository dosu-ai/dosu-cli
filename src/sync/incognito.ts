/** Per-session incognito: a session opts out of studying by carrying a marker in its transcript.
 * The `/dosu-incognito` slash command expands to text containing INCOGNITO_MARKER, which the
 * harness records as a user turn, so both the sync pipeline and the status line detect it by
 * reading the transcript. No session-id mapping, no extra state: the transcript is the switch. */

import { closeSync, fstatSync, openSync, readSync } from "node:fs";
import { codexAncestorRollouts } from "../sessions/codex-lineage";
import { opencodeLineage } from "../sessions/opencode";
import { readPiHeader } from "../sessions/pi";
import { readSessionTurns } from "../sessions/read";
import { type AgentSession, parentSessionOf } from "../sessions/scan";

/** The token the slash command body carries; versioned so the shape can evolve. */
export const INCOGNITO_MARKER = "dosu:incognito:v1";

/** The slash command's name, without the leading slash. */
export const INCOGNITO_COMMAND_NAME = "dosu-incognito";

/** Claude Code records a slash command as `<command-name>/name</command-name>` before (or
 * instead of) the expanded body, so the command name itself is a second, equivalent marker. */
const COMMAND_NAME_MARKER = `/${INCOGNITO_COMMAND_NAME}</command-name>`;

/** Transcripts larger than this are only scanned up to the cap: a session that big is an
 * outlier, and the marker is normally near the start of whatever turn set it. */
const MAX_SCAN_BYTES = 64 * 1024 * 1024;

export function textHasIncognitoMarker(text: string): boolean {
  return text.includes(INCOGNITO_MARKER) || text.includes(COMMAND_NAME_MARKER);
}

/** Whether a JSONL transcript file carries the incognito marker. Raw substring search on the
 * file, bounded by MAX_SCAN_BYTES; a missing or unreadable file reads as not incognito. */
export function transcriptHasIncognitoMarker(
  path: string,
  maxBytes: number = MAX_SCAN_BYTES,
): boolean {
  let fd: number | undefined;
  try {
    fd = openSync(path, "r");
    const size = Math.min(fstatSync(fd).size, maxBytes);
    if (size === 0) return false;
    const buffer = Buffer.allocUnsafe(size);
    let offset = 0;
    while (offset < size) {
      const read = readSync(fd, buffer, offset, size - offset, offset);
      if (read === 0) break;
      offset += read;
    }
    return textHasIncognitoMarker(buffer.toString("utf8", 0, offset));
  } catch {
    return false;
  } finally {
    if (fd !== undefined) {
      try {
        closeSync(fd);
      } catch {
        // Nothing left to release.
      }
    }
  }
}

/** How far up a chain of forks of forks the pi check looks. */
const MAX_FORK_DEPTH = 32;

/** pi's /dosu-incognito (the Dosu pi extension) sends the marker as a user message, so only the
 * user's turns count: a session whose model merely read a file quoting the marker still ships.
 * The transcript a fork or clone was copied from counts too, at any depth: a fork made before
 * the marker holds what the session did off the record and carries on from there. */
function piSessionIsIncognito(session: AgentSession): boolean {
  const seen = new Set<string>();
  let path: string | undefined = session.path;
  while (path && !seen.has(path) && seen.size < MAX_FORK_DEPTH) {
    seen.add(path);
    const transcript = { ...session, path };
    if (
      transcriptHasIncognitoMarker(path) &&
      readSessionTurns(transcript).some(
        (turn) => turn.role === "user" && textHasIncognitoMarker(turn.text),
      )
    ) {
      return true;
    }
    path = readPiHeader(path)?.parentSession;
  }
  return false;
}

/** Whether a scanned session opted out. File-backed harnesses scan the raw transcript; opencode
 * (SQLite) falls back to the parsed turns, of the session and of every session it was spawned
 * from; pi reads its user turns, and those of the sessions it was forked from. A subagent's
 * transcript never carries the marker, so it opts out with the session it worked for. Never
 * throws. */
export function isIncognitoSession(session: AgentSession): boolean {
  if (session.harness === "opencode") {
    return opencodeLineage(session).some((s) =>
      readSessionTurns(s).some((turn) => textHasIncognitoMarker(turn.text)),
    );
  }
  if (session.harness === "pi") return piSessionIsIncognito(session);
  if (session.harness === "codex") return codexRolloutIncognito(session.path);
  if (transcriptHasIncognitoMarker(session.path)) return true;
  const parent = parentSessionOf(session);
  return parent !== null && isIncognitoSession(parent);
}

/** A Codex rollout is off the record when it, or a rollout it descends from, carries the marker:
 * a subagent's rollout (unless spawned with its parent's history) and a fork's (0.160 references
 * its source instead of copying it) hold none of the session they came from. */
export function codexRolloutIncognito(path: string): boolean {
  if (transcriptHasIncognitoMarker(path)) return true;
  for (const ancestor of codexAncestorRollouts(path)) {
    if (transcriptHasIncognitoMarker(ancestor)) return true;
  }
  return false;
}

export interface IncognitoPartition {
  kept: AgentSession[];
  skipped: AgentSession[];
}

/** Split sessions into those to study and those that opted out. */
export function partitionIncognitoSessions(
  sessions: readonly AgentSession[],
  isIncognito: (session: AgentSession) => boolean = isIncognitoSession,
): IncognitoPartition {
  const kept: AgentSession[] = [];
  const skipped: AgentSession[] = [];
  for (const session of sessions) {
    (isIncognito(session) ? skipped : kept).push(session);
  }
  return { kept, skipped };
}
