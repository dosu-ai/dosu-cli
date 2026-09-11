/**
 * Capture write_knowledge payloads during a mining run, persist them, and
 * attribute rediscovery tokens the same way the skill report does: the cost
 * to learn THIS fact (the matching user-query cycle), never a session-sized
 * number and never an equal split of one session across notes.
 */

import {
  countRediscoveryToolCalls,
  estimateSessionTokens,
  readSessionTurns,
} from "../sessions/read";
import type { AgentSession } from "../sessions/scan";
import { digestTurnText, sessionToDigest } from "./digest";
import { extractUserQueries, sessionTitleFromUserText } from "./queries";
import type { DigestTurn, ReportCandidate, ReportInventory, ReportNote } from "./types";

export { digestsForSessions } from "./digest";

export function sessionIdFromReadInput(input: unknown): string | undefined {
  if (typeof input !== "object" || input === null || Array.isArray(input)) return undefined;
  const id = (input as Record<string, unknown>).id;
  return typeof id === "string" && id.trim() ? id : undefined;
}

const STOP_WORDS = new Set([
  "about",
  "after",
  "also",
  "and",
  "are",
  "but",
  "can",
  "does",
  "for",
  "from",
  "have",
  "into",
  "just",
  "must",
  "not",
  "that",
  "the",
  "this",
  "they",
  "with",
  "what",
  "when",
  "which",
  "will",
  "your",
]);

function significantWords(text: string): Set<string> {
  const out = new Set<string>();
  for (const raw of text.toLowerCase().match(/[a-z][a-z0-9._-]{2,}/g) ?? []) {
    const word = raw.replace(/^\.+|\.+$/g, "");
    if (word.length >= 3 && !STOP_WORDS.has(word)) out.add(word);
  }
  return out;
}

function overlapCount(a: Set<string>, b: Set<string>): number {
  let n = 0;
  for (const word of a) if (b.has(word)) n += 1;
  return n;
}

/** A note's title/content vocabulary, precomputed once per note for scoring. */
interface NoteWords {
  title: Set<string>;
  content: Set<string>;
}

function noteWords(note: Pick<ReportNote, "title" | "content">): NoteWords {
  return { title: significantWords(note.title), content: significantWords(note.content) };
}

/** One user-query cycle: a user turn and everything until the next user turn,
 * flattened to matchable text (turn text plus tool paths/patterns/commands). */
interface SessionCycle {
  start: number;
  end: number;
  text: string;
}

function sessionCycles(turns: readonly DigestTurn[]): SessionCycle[] {
  const starts: number[] = [];
  for (let i = 0; i < turns.length; i++) {
    if (turns[i].role === "user" && digestTurnText(turns[i]).trim()) starts.push(i);
  }
  return starts.map((start, i) => {
    const end = i + 1 < starts.length ? starts[i + 1] : turns.length;
    const text = turns
      .slice(start, end)
      .map((t) => {
        const paths = (t.tools ?? [])
          .map((tool) => tool.path || tool.pattern || tool.command_preview || "")
          .filter(Boolean)
          .join(" ");
        return `${digestTurnText(t)} ${paths}`;
      })
      .join("\n");
    return { start, end, text };
  });
}

/** Title words count double: the title is the note's identity, the body is corroboration. */
function cycleMatchScore(words: NoteWords, cycleText: string): number {
  const cycleWords = significantWords(cycleText);
  return overlapCount(words.title, cycleWords) * 2 + overlapCount(words.content, cycleWords);
}

function cleanedUserQuery(text: string): string {
  const queries = extractUserQueries(text);
  return (queries[0] ?? text).replace(/\s+/g, " ").trim();
}

/**
 * Cost to learn THIS note: the user-query cycle that best matches the title
 * (and content), not the whole session. The skill forbids inventing a
 * session-sized number or splitting one session budget equally across notes.
 * Cycles are assigned greedily so two notes never share the same stretch.
 */
export function attributeRediscovery(
  notes: readonly ReportNote[],
  sessions: readonly AgentSession[],
): ReportCandidate[] {
  const byId = new Map(sessions.map((s) => [s.id, s]));
  const candidates: ReportCandidate[] = notes.map((note) => ({
    title: note.title,
    content: note.content,
    transcript_id: note.transcript_id,
    repo: note.repo,
    branch: note.branch,
    status: "written",
  }));

  const indexesBySession = new Map<string, number[]>();
  for (let i = 0; i < notes.length; i++) {
    const id = notes[i].transcript_id;
    if (!id || !byId.has(id)) continue;
    const list = indexesBySession.get(id) ?? [];
    list.push(i);
    indexesBySession.set(id, list);
  }

  for (const [sessionId, indexes] of indexesBySession) {
    const session = byId.get(sessionId);
    if (!session) continue;
    const turns = sessionToDigest(session).turns;
    const firstUser = turns.find((t) => t.role === "user");
    const firstText = firstUser ? digestTurnText(firstUser) : "";
    const sessionTitle = firstText ? sessionTitleFromUserText(firstText) : undefined;
    for (const i of indexes) {
      if (sessionTitle) candidates[i].session_title = sessionTitle;
      if (firstText) candidates[i].user_query = cleanedUserQuery(firstText).slice(0, 200);
    }
    if (turns.length === 0) continue;

    const cycles = sessionCycles(turns);
    const taken = new Set<number>();
    const ranked = indexes
      .map((i) => {
        const words = noteWords(notes[i]);
        let bestScore = 0;
        for (const cycle of cycles) {
          const score = cycleMatchScore(words, cycle.text);
          if (score > bestScore) bestScore = score;
        }
        return { i, words, bestScore };
      })
      .sort((a, b) => b.bestScore - a.bestScore);

    for (const item of ranked) {
      if (item.bestScore <= 0) continue;
      let pick = -1;
      let pickScore = 0;
      for (let ci = 0; ci < cycles.length; ci++) {
        if (taken.has(ci)) continue;
        const score = cycleMatchScore(item.words, cycles[ci].text);
        if (score > pickScore) {
          pickScore = score;
          pick = ci;
        }
      }
      if (pick < 0 || pickScore <= 0) continue;
      taken.add(pick);
      const cycle = cycles[pick];
      const slice = turns.slice(cycle.start, cycle.end);
      const tokens = slice.reduce((sum, t) => sum + (Number(t.est_tokens) || 0), 0);
      candidates[item.i].approx_rediscovery_tokens = tokens;
      const startLine = slice[0]?.line ?? cycle.start + 1;
      const endLine = slice.at(-1)?.line ?? cycle.end;
      candidates[item.i].investigation_lines = `${startLine}-${endLine}`;
      const cycleUser = slice.find((t) => t.role === "user");
      if (cycleUser) {
        const q = digestTurnText(cycleUser);
        candidates[item.i].user_query = cleanedUserQuery(q).slice(0, 200);
        candidates[item.i].session_title = sessionTitleFromUserText(q);
      }
    }
  }

  return candidates;
}

export function sessionsToInventory(sessions: readonly AgentSession[]): ReportInventory {
  const transcripts = sessions.map((session) => {
    const turns = readSessionTurns(session);
    const queries = turns
      .filter((t) => t.role === "user")
      .flatMap((t) => extractUserQueries(t.text));
    const title = queries[0] ? sessionTitleFromUserText(queries[0]) : undefined;
    return {
      source: session.harness,
      transcript_id: session.id,
      ...(title ? { title } : {}),
      learning_tokens: estimateSessionTokens(session),
      rediscovery_tool_calls: countRediscoveryToolCalls(session),
      user_queries: queries.slice(0, 3),
    };
  });
  const learning_tokens = transcripts.reduce((sum, t) => sum + t.learning_tokens, 0);
  return { transcripts, totals: { learning_tokens } };
}
