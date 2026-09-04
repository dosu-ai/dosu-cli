/** In-process MCP tools that are the miner's only path to session content; every returned
 * string passes through the secret scrubber on top of the readers' own redaction. */

import { createSdkMcpServer, tool } from "@anthropic-ai/claude-agent-sdk";
import { z } from "zod";
import { readSessionTurns } from "../sessions/read";
import { redactSecrets } from "../sessions/redact";
import type { AgentSession } from "../sessions/scan";

// No hyphens: a hyphen in the server segment made models normalize the exposed
// `mcp__<server>__<tool>` name to underscores and burn turns on unknown-tool errors.
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

/** Render session turns from `offset`, redacted, within the response budget; `nextOffset` is
 * set when more turns remain. */
export function readSessionPage(session: AgentSession, offset = 0): ReadSessionPage {
  const turns = readSessionTurns(session);
  if (turns.length === 0) return { text: "(session has no readable conversation turns)" };
  if (offset >= turns.length) {
    return { text: `(offset ${offset} is past the end; session has ${turns.length} turns)` };
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

  const header = `Session ${session.id} (${session.harness}) \u00B7 turns ${offset}–${index - 1} of ${turns.length}`;
  const footer =
    index < turns.length
      ? `\n\n(more turns remain; call read_session again with offset=${index})`
      : "";
  return {
    text: `${header}\n\n${parts.join("\n\n")}${footer}`,
    nextOffset: index < turns.length ? index : undefined,
  };
}

/** Build the in-process MCP server scoped to this run's sessions. */
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
            return errorResult(`Unknown session id ${args.id}; it is not in scope for this run.`);
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
