/** Claude Code transcript lines → compact memory events. Tool calls are matched to their
 * results the way the frozen memwriter's `claude_code.py` does it (coding-memory-bench 0951e6a);
 * calls whose result lands in a later chunk wait in `pending`. Full tool output never leaves
 * this module: a command keeps only its return code and error line. */

import type { MemoryEvent } from "./api";
import { clip, parseCommandObservation, prepareRecordedCommand } from "./record-rules";
import type { PendingTool } from "./state";

const USER_PROMPT_CHARS = 32_000;
const ASSISTANT_TEXT_CHARS = 2_000;

const EDIT_TOOLS = new Set(["Edit", "Write", "MultiEdit"]);
/** A failed Bash result starts with this; anything else that errored was interrupted or denied,
 * not a completed command. */
const EXIT_CODE_RE = /^(?:Error: )?Exit code (-?\d+)/;

/** Claude Code scaffolding recorded as user text: slash-command echoes, `!` shell runs, local
 * command output, and background task notices. */
const SCAFFOLDING_TAG_RE =
  /^<(?:command-name|command-message|command-args|local-command-stdout|local-command-stderr|local-command-caveat|bash-input|bash-stdout|bash-stderr|task-notification)>/;
const SYSTEM_REMINDER_RE = /<system-reminder>[\s\S]*?<\/system-reminder>/g;
const INTERRUPTED_PREFIX = "[Request interrupted by user";

type JsonRecord = Record<string, unknown>;

function asRecord(value: unknown): JsonRecord | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as JsonRecord)
    : null;
}

/** `_result_text` from claude_code.py: a string, or the text of each block joined by newlines. */
function resultText(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .filter((block) => asRecord(block) !== null)
    .map((block) => {
      const text = (block as JsonRecord).text;
      return typeof text === "string" ? text : "";
    })
    .join("\n");
}

function blockTexts(content: unknown[]): string {
  return content
    .map(asRecord)
    .filter((block) => block?.type === "text" && typeof block.text === "string")
    .map((block) => (block as JsonRecord).text as string)
    .join("\n");
}

/** The text a person typed, or null for anything Claude Code or a hook put in a user line. */
function humanPromptText(record: JsonRecord, content: unknown): string | null {
  if (record.isMeta === true || record.isCompactSummary === true) return null;
  // Recent Claude Code tags every typed prompt; older versions tag nothing.
  const origin = asRecord(record.origin);
  if (origin && origin.kind !== "human") return null;
  const raw = typeof content === "string" ? content : blockTexts(content as unknown[]);
  const text = raw.replace(SYSTEM_REMINDER_RE, "").trim();
  if (text === "" || SCAFFOLDING_TAG_RE.test(text) || text.startsWith(INTERRUPTED_PREFIX)) {
    return null;
  }
  return text;
}

function relativePath(path: string, cwd: string): string {
  const prefix = `${cwd.replace(/\/+$/, "")}/`;
  return path.startsWith(prefix) ? path.slice(prefix.length) : path;
}

export interface Conversion {
  events: MemoryEvent[];
  pending: Record<string, PendingTool>;
}

/** Convert complete transcript lines; malformed lines are skipped. `cwd` makes edited paths
 * relative, as claude_code.py does. */
export function convertTranscriptLines(
  lines: string[],
  pending: Record<string, PendingTool>,
  cwd: string,
): Conversion {
  const open: Record<string, PendingTool> = { ...pending };
  const events: MemoryEvent[] = [];
  let lastTs = "";

  for (const line of lines) {
    let record: JsonRecord | null;
    try {
      record = asRecord(JSON.parse(line));
    } catch {
      continue;
    }
    if (!record || record.isSidechain === true) continue;
    const message = asRecord(record.message);
    const content = message?.content;
    if (typeof record.timestamp === "string") lastTs = record.timestamp;
    const ts = lastTs || new Date().toISOString();

    if (record.type === "assistant" && Array.isArray(content)) {
      if (record.isApiErrorMessage === true || message?.model === "<synthetic>") continue;
      const text = blockTexts(content).trim();
      if (text) events.push({ type: "assistant_text", ts, text: clip(text, ASSISTANT_TEXT_CHARS) });
      for (const block of content.map(asRecord)) {
        if (block?.type !== "tool_use" || typeof block.id !== "string") continue;
        const input = asRecord(block.input) ?? {};
        if (block.name === "Bash") {
          open[block.id] = {
            name: "Bash",
            command: prepareRecordedCommand(String(input.command ?? "")),
          };
        } else if (typeof block.name === "string" && EDIT_TOOLS.has(block.name)) {
          open[block.id] = { name: block.name, path: String(input.file_path ?? "") };
        }
      }
      continue;
    }

    if (record.type !== "user") continue;
    const results = Array.isArray(content)
      ? content.map(asRecord).filter((block) => block?.type === "tool_result")
      : [];
    if (results.length === 0) {
      const text =
        typeof content === "string" || Array.isArray(content)
          ? humanPromptText(record, content)
          : null;
      if (text) events.push({ type: "user_prompt", ts, text: clip(text, USER_PROMPT_CHARS) });
      continue;
    }
    for (const block of results as JsonRecord[]) {
      const id = typeof block.tool_use_id === "string" ? block.tool_use_id : "";
      const tool = open[id];
      if (!tool) continue;
      delete open[id];
      if (tool.name === "Bash") {
        const text = resultText(block.content);
        let returncode = 0;
        let output = text;
        if (block.is_error === true) {
          const match = EXIT_CODE_RE.exec(text);
          if (match === null) continue;
          returncode = Number.parseInt(match[1], 10);
          output = text.slice(match[0].length);
        }
        const parsed = parseCommandObservation(
          `<returncode>${returncode}</returncode>\n<output>\n${output}\n</output>`,
        );
        events.push({
          type: "command",
          ts,
          command: tool.command ?? "",
          rc: returncode,
          error_line: parsed?.[1] ?? null,
        });
      } else if (block.is_error !== true) {
        events.push({
          type: "file_edit",
          ts,
          tool: tool.name,
          path: relativePath(tool.path ?? "", cwd),
        });
      }
    }
  }
  return { events, pending: open };
}
