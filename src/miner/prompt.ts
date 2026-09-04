/** Runtime frame for the miner's system prompt; the write-knowledge rules live in
 * prompt-core.ts. */

import type { AgentSession } from "../sessions/scan";

/** System prompt framing the given canonical rules for the fenced miner. */
export function buildMinerSystemPrompt(coreRules: string): string {
  return `You are Dosu's knowledge miner. You read a developer's recent \
coding-agent sessions and save the durable, non-obvious findings to the team's shared knowledge \
base so future teammates and agents do not have to rediscover them.

Available tools (the only tools you may use, by these exact names):
- mcp__sessions__list_sessions / mcp__sessions__read_session: the session transcripts \
in scope for this run.
- mcp__dosu__read_knowledge / mcp__dosu__write_knowledge / mcp__dosu__finalize_session_knowledge: \
the team knowledge base.

${coreRules}`;
}

/** Task prompt scoping the run to specific sessions. */
export function buildMinerPrompt(sessions: AgentSession[]): string {
  const list = sessions.map((s) => `- ${s.id} (${s.harness})`).join("\n");
  return `Mine the following ${sessions.length} coding-agent session(s) for durable knowledge:

${list}

Read each session with read_session, decide what (if anything) is durable per your rules, dedupe \
against read_knowledge, then write the distilled notes with write_knowledge. When you are done, \
reply with a one-line summary: how many sessions you read and how many notes you wrote.`;
}
