/** Input a Claude Code session acted on that @letta-ai/trajectory would drop.
 *
 * Task notifications: Claude Code tells a session that a background task finished (a background
 * subagent, a background shell command) with a message that starts with `<task-notification>`
 * and carries the task's result. The normalizer drops it as harness noise, which is right about
 * who said it (not the user) and wrong about what it is: the result the model acted on next. A
 * foreground subagent's result stays in the session as its tool result; without this, a
 * background one's would vanish and the next turns would act on nothing visible. So it ships in
 * place, as an `observation` record: input the agent received that nobody typed.
 *
 * Queued input: whatever arrives while the agent is mid-turn waits in a queue and is logged not
 * as a user message but as an `attachment` row (`attachment.type: "queued_command"`), which the
 * adapter skips as transport. That is how an interactive session usually gets a background task's
 * notification (`commandMode: "task-notification"`), and how it gets a message the user typed
 * mid-turn (`commandMode: "prompt"`) or one from another agent session (`isMeta: true`). Each
 * ships as the input it stands for: the user's message as a user record, the rest as
 * observations.
 *
 * The normalizer has no option for either, so the transcript is rewritten before it runs (a
 * queued input becomes the user row it stands for, keeping its uuid, timestamp and sidechain
 * flag; input nobody typed is marked) and the marked user records become observations after. */

import type { NormalizedRecord } from "@letta-ai/trajectory";

const NOTIFICATION_PREFIX = "<task-notification";

/** The attachment type of input queued while the agent was busy. */
const QUEUED_COMMAND = "queued_command";

/** Prepended to a notification's text so the normalizer keeps it as a user record; private-use
 * code points, which no real prompt starts with. */
const MARK = "dosu-observation";

function startsNotification(text: unknown): boolean {
  return typeof text === "string" && text.trimStart().startsWith(NOTIFICATION_PREFIX);
}

/** The user row a queued input stands for, its text marked when nobody typed it; null for any
 * other row, and for queued input of a kind not seen yet (left to the adapter, which skips it). */
function queuedInputRow(row: Record<string, unknown>): Record<string, unknown> | null {
  const { attachment, ...rest } = row;
  if (row.type !== "attachment" || typeof attachment !== "object" || attachment === null) {
    return null;
  }
  const { type, prompt, commandMode, isMeta } = attachment as Record<string, unknown>;
  if (type !== QUEUED_COMMAND || typeof prompt !== "string") return null;
  const observed = commandMode === "task-notification" || isMeta === true;
  if (!observed && commandMode !== "prompt") return null;
  const content = observed ? `${MARK}${prompt}` : prompt;
  return { ...rest, type: "user", message: { role: "user", content } };
}

/** Mark one transcript row when the normalizer would drop it as a notification: a user message
 * whose text (a string, or its first text block) starts with the tag. Null when it would not. */
function markRow(row: Record<string, unknown>): Record<string, unknown> | null {
  const message = row.message as { content?: unknown } | undefined;
  if (row.type !== "user" || typeof message !== "object" || message === null) return null;
  const { content } = message;
  if (startsNotification(content)) {
    return { ...row, message: { ...message, content: `${MARK}${content}` } };
  }
  if (!Array.isArray(content)) return null;
  // The adapter joins a user message's text and image blocks in order; the first decides.
  const first = content.findIndex(
    (block) =>
      block?.type === "image" || (block?.type === "text" && typeof block.text === "string"),
  );
  if (first < 0 || !startsNotification(content[first].text)) return null;
  const blocks = [...content];
  blocks[first] = { ...blocks[first], text: `${MARK}${blocks[first].text}` };
  return { ...row, message: { ...message, content: blocks } };
}

const mayNeedRewrite = (text: string) =>
  text.includes(NOTIFICATION_PREFIX) || text.includes(QUEUED_COMMAND);

/** The transcript with queued input unqueued and every input nobody typed marked, so all of it
 * survives normalization. */
export function markClaudeInputs(transcript: string): string {
  if (!mayNeedRewrite(transcript)) return transcript;
  return transcript
    .split("\n")
    .map((line) => {
      if (!mayNeedRewrite(line)) return line;
      try {
        const row = JSON.parse(line) as Record<string, unknown>;
        const unqueued = queuedInputRow(row);
        const marked = markRow(unqueued ?? row) ?? unqueued;
        return marked ? JSON.stringify(marked) : line;
      } catch {
        return line;
      }
    })
    .join("\n");
}

/** The normalized records with each marked input turned into an observation, unmarked. */
export function markedAsObservations(records: NormalizedRecord[]): NormalizedRecord[] {
  return records.map((record) =>
    record.role === "user" && record.content.startsWith(MARK)
      ? {
          role: "observation",
          content: record.content.slice(MARK.length),
          timestamp: record.timestamp,
        }
      : record,
  );
}
