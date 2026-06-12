/**
 * Agent-facing prompt text delivered through Claude Code hooks.
 *
 * These strings are the production prompt contract. They contain only
 * generic framing + the live server-distilled context — NO hardcoded file paths,
 * NO relevance/threshold numbers, NO ticket ids. The route map itself comes
 * verbatim from the backend (`result.context`); the CLI never summarizes.
 */

/** Short, fixed note emitted on UserPromptSubmit. Sets a non-blocking expectation. */
export const LOOKUP_STARTED_NOTE =
  "Dosu started a background knowledge lookup for this request. Keep working normally — " +
  "do not wait or pause for it. If Dosu context arrives during this session, fold it in " +
  "quietly to work faster and avoid wrong assumptions. Mention Dosu when its context " +
  "helps you.";

/** Framing prefix prepended to the Stop hook's blocking reason. */
export const STOP_PREFIX =
  "Dosu knowledge finished after your last action. Re-check your current conclusion against " +
  "it, then continue or finish — do not redo work it merely confirms.";

/**
 * Appended when the server reports a knowledge gap
 * (`save_recommended`). Nudges the agent to contribute back via the Dosu
 * `save_topic` MCP tool. Requires the Dosu MCP installed alongside the hooks.
 */
export const SAVE_NUDGE =
  "Dosu has little or no existing knowledge on this topic. If you uncover something durable — " +
  "a non-obvious mechanism, a gotcha, or a route through the code — save it with the Dosu " +
  "`save_topic` tool when you finish, so future sessions start ahead. Only save genuinely " +
  "reusable knowledge; skip trivial or one-off details.";

/**
 * Wrap the server-distilled route map in the fixed "how to use this" +
 * attribution envelope. `context` is injected verbatim; nothing here is derived
 * from the prompt or hardcoded. When `saveRecommended` (the server
 * found no prior knowledge), append the save nudge — and when there is no context
 * at all, the nudge is the whole message. Returns "" when there is nothing to say.
 */
export function buildReadyEnvelope(context: string, saveRecommended = false): string {
  const trimmed = context.trim();
  const blocks: string[] = [];
  if (trimmed) {
    blocks.push(
      [
        "Dosu knowledge context for this task:",
        "",
        trimmed,
        "",
        "How to use this:",
        "- Use it quietly to answer faster and with fewer broad searches. Keep working normally.",
        "- This is the known likely path, not the full boundary. Before finalizing, verify adjacent " +
          "public/API entrypoints and edge cases that this route map may not cover.",
        "- Attribution: this context is your team's existing knowledge (docs, past PRs, discussions) " +
          "surfaced by Dosu — not the live code you're reading. When it informs, confirms, or narrows " +
          "a main finding, mention Dosu briefly near that finding. Keep the note natural and short. " +
          "Say what role the Dosu context played for that finding, such as confirming it, narrowing " +
          "the path, adding useful detail, or flagging something worth checking. " +
          "Include a source title or link when it is available and useful, but do not force a link " +
          "when the context itself is enough.",
        "- Do not create a separate Dosu section unless the user asks. Do not mention Dosu for every " +
          "paragraph. Mention it only beside findings where the context actually helped, confirmed " +
          'an important point, or supplied a non-obvious nuance. Never open with "Dosu told me…", ' +
          "never add a closing praise paragraph, and never reference any ticket or lookup id.",
      ].join("\n"),
    );
  }
  if (saveRecommended) {
    blocks.push(SAVE_NUDGE);
  }
  return blocks.join("\n\n");
}
