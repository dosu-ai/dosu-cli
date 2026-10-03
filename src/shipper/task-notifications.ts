/** Claude Code tells a session that a background task finished (a background subagent, a
 * background shell command) by injecting a user message that starts with `<task-notification>`
 * and carries the task's result. @letta-ai/trajectory drops it as harness noise, which is right
 * about who said it (not the user) and wrong about what it is: the result the model acted on next.
 * A foreground subagent's result stays in the session as its tool result; without this, a
 * background one's would vanish and the next turns would act on nothing visible. So it ships in
 * place, as an `observation` record: input the agent received that nobody typed.
 *
 * The normalizer has no option for this, so the transcript is marked before it runs and the
 * marked user records become observations after. */

import type { NormalizedRecord } from "@letta-ai/trajectory";

const NOTIFICATION_PREFIX = "<task-notification";

/** Prepended to a notification's text so the normalizer keeps it as a user record; private-use
 * code points, which no real prompt starts with. */
const MARK = "dosu-observation";

function startsNotification(text: unknown): boolean {
  return typeof text === "string" && text.trimStart().startsWith(NOTIFICATION_PREFIX);
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

/** The transcript with every task notification marked to survive normalization. */
export function markTaskNotifications(transcript: string): string {
  if (!transcript.includes(NOTIFICATION_PREFIX)) return transcript;
  return transcript
    .split("\n")
    .map((line) => {
      if (!line.includes(NOTIFICATION_PREFIX)) return line;
      try {
        const marked = markRow(JSON.parse(line) as Record<string, unknown>);
        return marked ? JSON.stringify(marked) : line;
      } catch {
        return line;
      }
    })
    .join("\n");
}

/** The normalized records with each marked notification turned into an observation, unmarked. */
export function notificationsAsObservations(records: NormalizedRecord[]): NormalizedRecord[] {
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
