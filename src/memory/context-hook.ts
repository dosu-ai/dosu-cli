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
import { GIT_BUDGETS, projectOverride, resolveProjectOfDir } from "../sessions/project";
import { createProjectDirResolver } from "../sessions/project-dir";
import { currentBranchAnswer, GIT_TIMED_OUT } from "../sessions/repo";
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
  /** The branch checked out in a directory now; defaults to asking git. */
  branchOf?: (cwd: string) => string | null | typeof GIT_TIMED_OUT;
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

/** The project key and branch for the prompt's cwd, cached under the session's scanner key so
 * the transcript ships under the same ones later, and the session's later prompts keep its first
 * branch; DOSU_PROJECT alone when the payload has no cwd. Both are null when git could not
 * answer within the prompt's budget, and git is not asked again: better no key than one the
 * session will not ship under, and no branch than a prompt kept waiting. */
function scopeOf(
  cwd: string | null,
  sessionKey: string | null,
  branchOf: NonNullable<ContextHookOptions["branchOf"]>,
): { project: string | null; branch: string | null } {
  if (cwd === null) return { project: projectOverride(null)?.project ?? null, branch: null };
  if (sessionKey === null) {
    // Null only when git ran out of time.
    const project = resolveProjectOfDir(cwd, { budget: GIT_BUDGETS.prompt })?.project ?? null;
    const branch = project === null ? null : branchOf(cwd);
    return { project, branch: branch === GIT_TIMED_OUT ? null : branch };
  }
  const resolver = createProjectDirResolver(undefined, { currentBranch: branchOf });
  const project = resolver.resolveProjectAt(sessionKey, cwd)?.project ?? null;
  const branch = resolver.resolveBranchAt(sessionKey, cwd);
  resolver.flush();
  return { project, branch };
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
  const fetchImpl = options.fetchImpl ?? fetch;
  try {
    const sessionId = sessionIdOf(payload, format);
    const harness = harnessOf(agent);
    const { project, branch } = scopeOf(
      cwd,
      harness && sessionId ? `${harness}/${sessionId}` : null,
      options.branchOf ?? currentBranchAnswer,
    );
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
      signal: AbortSignal.timeout(options.timeoutMs ?? CONTEXT_TIMEOUT_MS),
    });
    if (response.status !== 200) return "";
    const body = (await response.json()) as ContextResponse;
    const digest = str(body.digest);
    if (!digest) return "";
    if (format === "plain") return digest;
    // Codex reads Claude Code's hook output shape.
    return JSON.stringify({
      hookSpecificOutput: { hookEventName: "UserPromptSubmit", additionalContext: digest },
    });
  } catch {
    return "";
  }
}
