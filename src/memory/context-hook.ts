/** Prompt-time memory: the `UserPromptSubmit` hook behind `dosu knowledge context` (Claude Code,
 * Codex), and the same lookup for agents whose plugins ask from code (OpenCode, Pi: `--format
 * plain`).
 *
 * Reads the hook payload from stdin, asks the server whether this prompt warrants a memory
 * digest (POST /v1/memory/context), and prints the hook's JSON when it does. The server makes
 * the decision -- it skips steers, drops memories the session has already been shown, and asks
 * a classifier whether the rest would change how the task starts -- so this side only has to be
 * fast and harmless.
 *
 * Harmless is the hard constraint. The hook runs while the user's prompt waits, and a hook that
 * errors surfaces that error to them mid-sentence. So every failure -- no credentials, a slow
 * or down server, a malformed payload -- produces no output and a clean exit, and the prompt
 * goes through exactly as if Dosu were not installed. */

import { basename } from "node:path";
import { logger } from "../debug/logger";
import { GIT_BUDGETS, projectOverride, resolveProjectOfDir } from "../sessions/project";
import { createProjectDirResolver } from "../sessions/project-dir";
import { SESSION_HARNESSES } from "../sessions/scan";
import { trajectorySourceOf } from "../shipper/normalize";
import {
  codexRolloutIncognito,
  textHasIncognitoMarker,
  transcriptHasIncognitoMarker,
} from "../sync/incognito";

/** Retrieval is ~0.6s warm and ~2.5s cold, plus ~0.15s for the classifier. Past this the user
 * is waiting on us, and a late digest is not worth a stalled prompt. */
const CONTEXT_TIMEOUT_MS = 4_000;

/** The trajectory source the session's transcript will later ingest under, so a pushed memory
 * ranks by the same scope its evidence will get. */
const CLAUDE_CODE_AGENT = "claude-code";

/** What the hook prints: the agent's hook JSON (`claude`, `codex`), or the digest alone. */
export type ContextFormat = "claude" | "codex" | "plain";
export const CONTEXT_FORMATS: readonly ContextFormat[] = ["claude", "codex", "plain"];

/** Prompts the agent submits on its own when a background task or subagent finishes (Claude
 * Code `<task-notification>`, Codex `<subagent_notification>`): nobody typed them, so they ask
 * nothing of memory. */
const NOTIFICATION_PROMPT = /^\s*<(task-notification|subagent_notification)>/;

interface PromptHookPayload {
  hook_event_name?: unknown;
  session_id?: unknown;
  prompt?: unknown;
  cwd?: unknown;
  transcript_path?: unknown;
}

interface ContextResponse {
  digest?: unknown;
  reason?: unknown;
  memory_ids?: unknown;
}

export interface ContextHookOptions {
  apiKey: string;
  deploymentId: string;
  backendUrl: string;
  /** The trajectory source the session ships as (default `claude-code`). */
  agent?: string;
  format?: ContextFormat;
  timeoutMs?: number;
  /** Injectable boundaries, for tests. */
  fetchImpl?: (input: string, init?: RequestInit) => Promise<Response>;
  branchOf?: (cwd: string) => string | null;
  isIncognito?: (transcriptPath: string) => boolean;
}

function str(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

/** The scanner's harness id for a trajectory source (`claude-code` -> `claude`); null for an
 * agent the scanner does not list. */
function harnessOf(agent: string): string | null {
  return SESSION_HARNESSES.find((h) => trajectorySourceOf(h) === agent || h === agent) ?? null;
}

/** The project key for the prompt's cwd, cached under the session's scanner key so the
 * transcript ships under the same one later; DOSU_PROJECT alone when the payload has no cwd.
 * Null when git could not answer within the prompt's budget: better no key than one the session
 * will not ship under. */
function projectOf(cwd: string | null, sessionKey: string | null): string | null {
  if (cwd === null) return projectOverride(null)?.project ?? null;
  if (sessionKey === null) {
    return resolveProjectOfDir(cwd, { budget: GIT_BUDGETS.prompt })?.project ?? null;
  }
  const resolver = createProjectDirResolver();
  const resolved = resolver.resolveProjectAt(sessionKey, cwd);
  resolver.flush();
  return resolved?.project ?? null;
}

/** The session id the scanner and the shipped session use. Codex's is its rollout's filename
 * stem: the payload's `session_id` is the root session's, even inside a subagent. */
function sessionIdOf(payload: PromptHookPayload, format: ContextFormat): string | null {
  const transcript = str(payload.transcript_path);
  if (format === "codex" && transcript?.endsWith(".jsonl")) return basename(transcript, ".jsonl");
  return str(payload.session_id);
}

/** The hook's stdout for one payload: the additionalContext JSON, or "" to add nothing. */
export async function contextHookOutput(
  stdin: string,
  options: ContextHookOptions,
): Promise<string> {
  let payload: PromptHookPayload;
  try {
    payload = JSON.parse(stdin) as PromptHookPayload;
  } catch {
    return "";
  }
  const format = options.format ?? "claude";
  if (format !== "plain" && payload.hook_event_name !== "UserPromptSubmit") return "";
  const prompt = str(payload.prompt);
  if (!prompt || NOTIFICATION_PROMPT.test(prompt)) return "";

  // The prompt is sent to Dosu and logged as the retrieval query, so a session the user took
  // off the record must not be queried either -- same opt-out transcript shipping honors.
  if (textHasIncognitoMarker(prompt)) return "";
  const agent = options.agent ?? CLAUDE_CODE_AGENT;
  const transcript = str(payload.transcript_path);
  const isIncognito =
    options.isIncognito ??
    (agent === "codex" ? codexRolloutIncognito : transcriptHasIncognitoMarker);
  if (transcript && isIncognito(transcript)) return "";

  const cwd = str(payload.cwd);
  const branch = cwd ? (options.branchOf?.(cwd) ?? null) : null;
  const fetchImpl = options.fetchImpl ?? fetch;
  const sessionId = sessionIdOf(payload, format);
  const budgetMs = options.timeoutMs ?? CONTEXT_TIMEOUT_MS;
  const startedAt = Date.now();
  // Every outcome looks the same to the user -- no digest, prompt unchanged -- so the debug log
  // is where this says which it was (never the prompt or the digest).
  const note = (outcome: string) =>
    logger.debug(
      "context",
      `${agent} ${sessionId ?? "-"}: ${outcome} in ${Date.now() - startedAt}ms`,
    );
  let signal: AbortSignal | undefined;
  try {
    const harness = harnessOf(agent);
    const project = projectOf(cwd, harness && sessionId ? `${harness}/${sessionId}` : null);
    signal = AbortSignal.timeout(budgetMs);
    const response = await fetchImpl(`${options.backendUrl.replace(/\/$/, "")}/v1/memory/context`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-Dosu-API-Key": options.apiKey },
      body: JSON.stringify({
        deployment_id: options.deploymentId,
        prompt,
        session_id: sessionId,
        branch,
        agent,
        // `repo` repeats the key for servers that predate `project`.
        project,
        repo: project,
      }),
      signal,
    });
    if (response.status !== 200) {
      note(`no digest, HTTP ${response.status}`);
      return "";
    }
    const body = (await response.json()) as ContextResponse;
    const digest = str(body.digest);
    if (!digest) {
      note(`no digest, ${str(body.reason) ?? "none"}`);
      return "";
    }
    const count = Array.isArray(body.memory_ids) ? body.memory_ids.length : 0;
    note(`injected ${count} ${count === 1 ? "memory" : "memories"}`);
    if (format === "plain") return digest;
    // Codex reads Claude Code's hook output shape.
    return JSON.stringify({
      hookSpecificOutput: { hookEventName: "UserPromptSubmit", additionalContext: digest },
    });
  } catch (err) {
    note(
      signal?.aborted
        ? `no digest, no answer within the ${budgetMs}ms budget`
        : `no digest, ${err instanceof Error ? err.message : String(err)}`,
    );
    return "";
  }
}
