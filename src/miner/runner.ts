/**
 * Mining-agent runner: spawns a Claude Agent SDK session whose model
 * traffic routes to the Dosu LLM gateway, fenced to exactly four tools —
 * the in-process session readers and the remote Dosu knowledge tools.
 *
 * This is the only module in the CLI that imports the Agent SDK.
 */

import { getLlmGatewayURL } from "../config/constants";
import { logger } from "../debug/logger";
import { mcpHeaders, mcpURL } from "../mcp/config-helpers";
import type { AgentSession } from "../sessions/scan";
import { getVersionString } from "../version/version";
import { createRunConfigDir } from "./config-dir";
import { detectSettingsConflicts } from "./conflicts";
import { buildMinerEnv, type MinerTrigger } from "./env";
import { resolveClaudeExecutable } from "./executable";
import { buildMinerPrompt, buildMinerSystemPrompt } from "./prompt";
import { resolveMinerCoreRules } from "./prompt-source";
import { createSessionToolsServer, SESSIONS_SERVER_NAME } from "./tools";

export type MinerOutcome =
  | "completed"
  | "settings_conflict"
  | "consent_off"
  | "credit_limit"
  | "quota_exceeded"
  | "error";

export interface MinerRunResult {
  outcome: MinerOutcome;
  /** write_knowledge calls that were allowed through the gate. */
  notesWritten: number;
  turns: number;
  /** One renderable line for error-ish outcomes; never a stack trace. */
  message?: string;
}

export interface RunMinerOptions {
  sessions: AgentSession[];
  apiKey: string;
  deploymentID: string;
  trigger: MinerTrigger;
  runID?: string;
  /** Defaults to getLlmGatewayURL(). */
  gatewayURL?: string;
  maxTurns?: number;
  /** Cap on write_knowledge calls per run. */
  maxNotes?: number;
  /** Wall-clock abort. Default 10 minutes. */
  timeoutMs?: number;
}

const DEFAULT_MAX_TURNS = 50;
const DEFAULT_MAX_NOTES = 20;
const DEFAULT_TIMEOUT_MS = 10 * 60 * 1000;

const KNOWLEDGE_SERVER_NAME = "dosu";

/** Renderable copy for the gateway's machine-readable refusals. */
const GATEWAY_ERRORS: Record<string, { outcome: MinerOutcome; message: string }> = {
  dosu_consent_off: {
    outcome: "consent_off",
    message: "Your org hasn't enabled Dosu Remote Sessions. Ask an org admin to turn it on.",
  },
  dosu_credit_limit_reached: {
    outcome: "credit_limit",
    message:
      "Your org has used its Dosu credits for this billing period. An admin can enable overage or upgrade.",
  },
  dosu_quota_exceeded: {
    outcome: "quota_exceeded",
    message: "Daily Dosu Remote Sessions budget reached; runs resume tomorrow.",
  },
};

export function classifyGatewayError(
  text: string,
): { outcome: MinerOutcome; message: string } | null {
  for (const [token, mapped] of Object.entries(GATEWAY_ERRORS)) {
    if (text.includes(token)) return mapped;
  }
  return null;
}

/** Longest snippet a single trace line quotes from agent text or tool args. */
const TRACE_SNIPPET_LIMIT = 400;

function snippet(value: unknown): string {
  const text = typeof value === "string" ? value : JSON.stringify(value);
  const flat = (text ?? "").replace(/\s+/g, " ").trim();
  return flat.length > TRACE_SNIPPET_LIMIT ? `${flat.slice(0, TRACE_SNIPPET_LIMIT)}…` : flat;
}

/**
 * Turn-by-turn trace of the mining agent in the debug log: what it says,
 * every tool call with its arguments, and the size of what came back.
 * `dosu knowledge sync` is quiet on stdout by design, so the debug log is
 * where a run can actually be watched.
 */
export function traceAgentMessage(message: unknown): void {
  const msg = message as {
    type?: string;
    message?: { content?: unknown };
  };
  const content = msg.message?.content;
  if (!Array.isArray(content)) return;

  for (const block of content as Array<Record<string, unknown>>) {
    if (msg.type === "assistant" && block.type === "text") {
      logger.debug("miner", `[agent] ${snippet(block.text)}`);
    } else if (msg.type === "assistant" && block.type === "tool_use") {
      logger.debug("miner", `[agent] → ${block.name} ${snippet(block.input)}`);
    } else if (msg.type === "user" && block.type === "tool_result") {
      const full = JSON.stringify(block.content ?? "");
      logger.debug(
        "miner",
        `[agent] ← result ${full.length} chars${block.is_error ? " (error)" : ""}: ${snippet(block.content).slice(0, 120)}`,
      );
    }
  }
}

function allowedToolNames(): Set<string> {
  return new Set([
    `mcp__${SESSIONS_SERVER_NAME}__list_sessions`,
    `mcp__${SESSIONS_SERVER_NAME}__read_session`,
    `mcp__${KNOWLEDGE_SERVER_NAME}__read_knowledge`,
    `mcp__${KNOWLEDGE_SERVER_NAME}__write_knowledge`,
    `mcp__${KNOWLEDGE_SERVER_NAME}__finalize_session_knowledge`,
  ]);
}

export async function runMiner(options: RunMinerOptions): Promise<MinerRunResult> {
  // Fail closed before spawning anything: a managed settings file can
  // reroute the binary's auth no matter what env we build.
  const conflicts = detectSettingsConflicts();
  if (conflicts.length > 0) {
    const detail = conflicts.map((c) => `${c.file} (${c.keys.join(", ")})`).join("; ");
    return {
      outcome: "settings_conflict",
      notesWritten: 0,
      turns: 0,
      message: `Refusing to run: conflicting Claude Code settings would override the miner's auth (${detail})`,
    };
  }

  // The SDK is dynamically imported so no other CLI path pays its cost.
  const { query } = await import("@anthropic-ai/claude-agent-sdk");

  // Compiled/bundled installs don't carry the SDK's native binary; fall back
  // to a system Claude Code so hook-triggered runs work outside a checkout.
  const claudeExecutable = resolveClaudeExecutable();
  if (claudeExecutable) {
    logger.debug("miner", `using system Claude Code executable: ${claudeExecutable}`);
  }

  const configDir = createRunConfigDir();
  const runID = options.runID ?? crypto.randomUUID();
  // ISO-8601 strings with identical precision compare correctly as strings;
  // the oldest session's timestamp bounds the batch's learning window.
  const sessionStartedAt = options.sessions.map((s) => s.updated).sort()[0];
  const allowed = allowedToolNames();
  const maxNotes = options.maxNotes ?? DEFAULT_MAX_NOTES;
  const abort = new AbortController();
  const timer = setTimeout(() => abort.abort(), options.timeoutMs ?? DEFAULT_TIMEOUT_MS);

  let notesWritten = 0;
  let turns = 0;

  const env = buildMinerEnv({
    apiKey: options.apiKey,
    gatewayURL: options.gatewayURL ?? getLlmGatewayURL(),
    configDir: configDir.path,
    runID,
    trigger: options.trigger,
    cliVersion: getVersionString(),
    deploymentID: options.deploymentID,
  });

  // Rules come from the installed Dosu skill when present, so skill-repo
  // updates apply without a CLI release; the vendored copy is the fallback.
  const coreRules = resolveMinerCoreRules();
  logger.debug("miner", `write-knowledge rules source: ${coreRules.source}`);

  try {
    const run = query({
      prompt: buildMinerPrompt(options.sessions),
      options: {
        systemPrompt: buildMinerSystemPrompt(coreRules.rules),
        env: env as Record<string, string>,
        abortController: abort,
        maxTurns: options.maxTurns ?? DEFAULT_MAX_TURNS,
        // No filesystem settings: user/project/local settings files must not
        // reach the miner (managed policy is handled by the conflict check).
        settingSources: [],
        persistSession: false,
        ...(claudeExecutable ? { pathToClaudeCodeExecutable: claudeExecutable } : {}),
        sandbox: { enabled: true, failIfUnavailable: false },
        mcpServers: {
          [SESSIONS_SERVER_NAME]: createSessionToolsServer(options.sessions),
          [KNOWLEDGE_SERVER_NAME]: {
            type: "http",
            url: mcpURL(options.deploymentID),
            // Session-context headers (dosu#12249/#12264): the backend reads
            // these per request and stores them on each note; backends
            // without the feature ignore them. Session id = this mining run —
            // the transcripts' own ids vary per note. Session start = the
            // oldest mined session, bounding the learning window. X-Dosu-Repo/
            // -Branch/-Commit (the anchor attempt) are deliberately omitted:
            // one run mines sessions from many repos, and absent beats wrong.
            // X-Dosu-Model is the gateway's call, not ours.
            headers: {
              ...mcpHeaders(options.apiKey),
              "X-Dosu-Session-Id": runID,
              "X-Dosu-Client": `dosu-cli-miner/${getVersionString()}`,
              ...(sessionStartedAt ? { "X-Dosu-Session-Started-At": sessionStartedAt } : {}),
            },
          },
        },
        // Deliberately NO allowedTools: bare entries there auto-approve the
        // tool before canUseTool is consulted (CLAUDE_SDK_CAN_USE_TOOL_SHADOWED),
        // which would bypass the note cap. canUseTool is the single hard gate.
        stderr: (data) => logger.debug("miner", `[sdk] ${data}`),
        canUseTool: async (toolName, input) => {
          if (!allowed.has(toolName)) {
            return {
              behavior: "deny",
              message: `Tool ${toolName} is not permitted in mining runs.`,
            };
          }
          if (toolName === `mcp__${KNOWLEDGE_SERVER_NAME}__write_knowledge`) {
            if (notesWritten >= maxNotes) {
              return {
                behavior: "deny",
                message: `Note cap reached (${maxNotes} per run); stop writing and summarize.`,
              };
            }
            notesWritten += 1;
          }
          return { behavior: "allow", updatedInput: input };
        },
      },
    });

    for await (const message of run) {
      traceAgentMessage(message);
      if (message.type === "result") {
        turns = message.num_turns;
        const text = message.subtype === "success" ? message.result : message.subtype;
        const gatewayError = classifyGatewayError(text ?? "");
        if (gatewayError) {
          return {
            outcome: gatewayError.outcome,
            notesWritten,
            turns,
            message: gatewayError.message,
          };
        }
        if (message.subtype !== "success" || message.is_error) {
          logger.debug("miner", `run ${runID} failed: ${text}`);
          return {
            outcome: "error",
            notesWritten,
            turns,
            message: "Mining run failed; see debug log for details.",
          };
        }
        logger.debug("miner", `run ${runID} completed: ${turns} turns, ${notesWritten} notes`);
        return { outcome: "completed", notesWritten, turns, message: text };
      }
    }

    return {
      outcome: "error",
      notesWritten,
      turns,
      message: "Mining run ended without a result.",
    };
  } catch (error) {
    const text = error instanceof Error ? error.message : String(error);
    const gatewayError = classifyGatewayError(text);
    if (gatewayError) {
      return { outcome: gatewayError.outcome, notesWritten, turns, message: gatewayError.message };
    }
    logger.debug("miner", `run ${runID} threw: ${text}`);
    return {
      outcome: "error",
      notesWritten,
      turns,
      message: abort.signal.aborted
        ? "Mining run timed out and was aborted."
        : "Mining run failed; see debug log for details.",
    };
  } finally {
    clearTimeout(timer);
    configDir.cleanup();
  }
}
