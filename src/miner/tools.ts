/**
 * In-process MCP tools exposing the run's scoped sessions to the miner.
 *
 * The model never touches the filesystem: these tools are the only path to
 * session content. Reads go through the native readers (`src/sessions/`),
 * and every string is routed through the secret scrubber before returning —
 * the readers' own redaction is belt one, this is belt two.
 */

import { createSdkMcpServer, tool } from "@anthropic-ai/claude-agent-sdk";
import { z } from "zod";
import { readSessionTurns } from "../sessions/read";
import { redactSecrets } from "../sessions/redact";
import type { AgentSession } from "../sessions/scan";

// No hyphens: the SDK exposes tools as `mcp__<server>__<tool>`, and a hyphen
// inside the server segment ("dosu-sessions" → mcp__dosu-sessions__read_session)
// made models normalize it to an underscore and burn turns on unknown-tool
// errors before self-correcting.
export const SESSIONS_SERVER_NAME = "sessions";

/** Response budget per read_session call; the model pages with `offset`. */
export const MAX_READ_CHARS = 30_000;

function textResult(text: string) {
  return { content: [{ type: "text" as const, text }] };
}

function errorResult(text: string) {
  return { content: [{ type: "text" as const, text }], isError: true };
}

export function formatSessionList(sessions: AgentSession[]): string {
  if (sessions.length === 0) return "No sessions in scope for this run.";
  const lines = sessions.map((s) => {
    const project = s.project ? ` project=${s.project}` : "";
    return `- id=${s.id} agent=${s.harness} updated=${s.updated}${project}`;
  });
  return `Sessions in scope for this run:\n${lines.join("\n")}`;
}

export interface ReadSessionPage {
  text: string;
  nextOffset?: number;
}

/**
 * Render session turns from `offset`, redacted, within the response budget.
 * `nextOffset` is set when more turns remain.
 */
export function readSessionPage(session: AgentSession, offset = 0): ReadSessionPage {
  const turns = readSessionTurns(session);
  if (turns.length === 0) return { text: "(session has no readable conversation turns)" };
  if (offset >= turns.length) {
    return { text: `(offset ${offset} is past the end — session has ${turns.length} turns)` };
  }

  const parts: string[] = [];
  let used = 0;
  let index = offset;
  while (index < turns.length) {
    const turn = turns[index];
    const rendered = `[${index}] ${turn.role.toUpperCase()}:\n${redactSecrets(turn.text).text}`;
    // Always include at least one turn so pagination progresses, even when a
    // single turn exceeds the budget.
    if (parts.length > 0 && used + rendered.length > MAX_READ_CHARS) break;
    parts.push(
      rendered.length > MAX_READ_CHARS ? `${rendered.slice(0, MAX_READ_CHARS)}…` : rendered,
    );
    used += rendered.length;
    index += 1;
    if (used >= MAX_READ_CHARS) break;
  }

  const header = `Session ${session.id} (${session.harness}) — turns ${offset}–${index - 1} of ${turns.length}`;
  const footer =
    index < turns.length
      ? `\n\n(more turns remain — call read_session again with offset=${index})`
      : "";
  return {
    text: `${header}\n\n${parts.join("\n\n")}${footer}`,
    nextOffset: index < turns.length ? index : undefined,
  };
}

/**
 * Build the in-process MCP server scoped to this run's sessions.
 */
export function createSessionToolsServer(sessions: AgentSession[]) {
  const byId = new Map(sessions.map((s) => [s.id, s]));

  return createSdkMcpServer({
    name: SESSIONS_SERVER_NAME,
    version: "1.0.0",
    tools: [
      tool(
        "list_sessions",
        "List the coding-agent sessions in scope for this mining run.",
        {},
        async () => textResult(formatSessionList(sessions)),
      ),
      tool(
        "read_session",
        "Read the conversation turns of one in-scope session. Responses are " +
          "paginated; pass the returned offset to continue reading.",
        {
          id: z.string().describe("Session id from list_sessions"),
          offset: z.number().int().min(0).optional().describe("Turn index to start from"),
        },
        async (args) => {
          const session = byId.get(args.id);
          if (!session) {
            return errorResult(`Unknown session id ${args.id} — it is not in scope for this run.`);
          }
          try {
            return textResult(readSessionPage(session, args.offset ?? 0).text);
          } catch (error) {
            return errorResult(
              `Failed to read session ${args.id}: ${error instanceof Error ? error.message : String(error)}`,
            );
          }
        },
      ),
    ],
  });
}
