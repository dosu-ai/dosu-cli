/** What a session's native log says about how it began, read without normalizing it: the
 * branch it recorded as it started (Claude Code's earliest `gitBranch`, Codex's
 * `session_meta`), and when its own first prompt was, past any history a fork copied. The ship
 * step sends the branch as a fallback (the server prefers what the transcript recorded, read
 * the same way from the normalized records); a prompt hook uses the time to ask the reflog
 * which branch the session began on. */

import { readFileSync } from "node:fs";
import { recordedBranch } from "./branch";
import { opencodeTranscript } from "./opencode";
import type { SessionStart } from "./project-dir";
import { jsonlRecords } from "./read";
import type { AgentSession } from "./scan";

/** The trajectory source a harness's transcripts normalize as (the server's `agent`), and
 * whether the server can normalize it at all. */
const HARNESS_SOURCES: Record<string, string> = {
  claude: "claude-code",
  cursor: "cursor",
  codex: "codex",
  opencode: "opencode",
  pi: "pi",
  gemini: "gemini-cli",
};

export function trajectorySourceOf(harness: string): string | undefined {
  return HARNESS_SOURCES[harness];
}

type JsonRecord = Record<string, unknown>;

function asRecord(value: unknown): JsonRecord | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as JsonRecord)
    : null;
}

function timestampOf(value: unknown): string | undefined {
  return typeof value === "string" && value ? value : undefined;
}

/** Claude Code: `gitBranch` on the earliest record that has one; the first `user` record that
 * is this session's own (not copied from the session it was branched from) and is a prompt
 * (not a tool result). */
function claudeStart(records: JsonRecord[]): SessionStart {
  let recorded: string | null = null;
  let firstPromptAt: string | undefined;
  for (const record of records) {
    if (recorded === null) recorded = recordedBranch(record.gitBranch);
    if (firstPromptAt === undefined && record.type === "user" && record.isSidechain !== true) {
      const copied = asRecord(record.forkedFrom) !== null;
      const message = asRecord(record.message);
      const content = message?.content;
      const toolResult =
        Array.isArray(content) && content.every((c) => asRecord(c)?.type === "tool_result");
      if (!copied && !toolResult) firstPromptAt = timestampOf(record.timestamp);
    }
    if (recorded !== null && firstPromptAt !== undefined) break;
  }
  return { recorded, firstPromptAt };
}

/** Codex: `session_meta.payload.git.branch`; the first user message. */
function codexStart(records: JsonRecord[]): SessionStart {
  let recorded: string | null = null;
  let firstPromptAt: string | undefined;
  for (const record of records) {
    const payload = asRecord(record.payload);
    if (record.type === "session_meta") {
      recorded = recordedBranch(asRecord(payload?.git)?.branch);
      continue;
    }
    if (
      firstPromptAt === undefined &&
      record.type === "response_item" &&
      payload?.type === "message" &&
      payload.role === "user"
    ) {
      firstPromptAt = timestampOf(record.timestamp);
    }
    if (recorded !== null && firstPromptAt !== undefined) break;
  }
  return { recorded, firstPromptAt };
}

/** Cursor and pi record no branch; their first user message is the first prompt. */
function genericStart(records: JsonRecord[]): SessionStart {
  for (const record of records) {
    const message = asRecord(record.message);
    const role = record.role ?? message?.role;
    if (role === "user") {
      return { recorded: null, firstPromptAt: timestampOf(record.timestamp) };
    }
  }
  return { recorded: null };
}

/** OpenCode records no branch; its first user message's creation time is the first prompt.
 * Read from the DB alone (a prompt hook cannot wait for the binary's start). */
function opencodeStart(session: AgentSession): SessionStart | null {
  const raw = opencodeTranscript(session, { binary: false });
  if (raw === null) return null;
  const doc = JSON.parse(raw) as {
    messages?: { info?: { role?: string; time?: { created?: unknown } } }[];
  };
  const created = doc.messages?.find((m) => m.info?.role === "user")?.info?.time?.created;
  return {
    recorded: null,
    ...(typeof created === "number" ? { firstPromptAt: new Date(created).toISOString() } : {}),
  };
}

/** How a session began, from its log on disk; null when the log cannot be read. */
export function peekSessionStart(session: AgentSession): SessionStart | null {
  if (session.harness === "opencode") return opencodeStart(session);
  let raw: string;
  try {
    raw = readFileSync(session.path, "utf8");
  } catch {
    return null;
  }
  const records = jsonlRecords(raw);
  switch (session.harness) {
    case "claude":
      return claudeStart(records);
    case "codex":
      return codexStart(records);
    default:
      return genericStart(records);
  }
}
