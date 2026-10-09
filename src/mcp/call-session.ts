/** The agent session an MCP tool call belongs to, which the proxy sends as x-dosu-session so the
 * memory a session pulls joins what was pushed to it and the transcript it ships under the same
 * id; and whether that session is off the record, in which case the call never leaves the
 * machine.
 *
 * One stdio server can outlive a session (Claude Code's /clear and in-app resume keep it) or
 * serve several at once (one opencode process runs many sessions through one MCP child), so the
 * session is read per call, from what each agent attaches to it:
 * - Codex: the thread in every call's `_meta` (0.140 and 0.160), which names its rollout.
 * - Claude Code: the call's tool-use id in `_meta`, under which Dosu's PreToolUse hook recorded
 *   the session just before the call (recordClaudeToolCall); else the session Claude Code started
 *   this server in (CLAUDE_CODE_SESSION_ID). Only Claude Code's server reads that variable: every
 *   shell Claude Code runs carries it, so another agent started from one passes it on.
 * - OpenCode and pi: SESSION_ARGUMENT, which Dosu's plugin (OpenCode) or extension (pi) adds to
 *   the memory tools' arguments. Only those two agents' servers take it, and every server removes
 *   it before relaying, since the server's tool schemas are strict.
 * - Cursor names no session in its calls and runs no Dosu hook that could, so its /dosu-incognito
 *   keeps the memory tools off by instruction only.
 *
 * An agent the user put in incognito (`dosu knowledge incognito on`) needs no session named: no
 * call its server gets leaves the machine (callRefusal). */

import { mkdirSync, readdirSync, readFileSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { basename, join } from "node:path";
import { getConfigDir } from "../config/config";
import { claudeConfigDir } from "../hooks/claude-code";
import { codexRolloutOfThread } from "../sessions/codex-lineage";
import {
  type AgentSession,
  opencodeSessionById,
  piSessionById,
  SESSION_HARNESSES,
  type SessionHarness,
  sessionAtPath,
} from "../sessions/scan";
import { trajectorySourceOf } from "../shipper/normalize";
import { isIncognitoSession } from "../sync/incognito";
import {
  isSessionAgentIncognito,
  loadSyncState,
  type SyncState,
  unreadableStateMessage,
} from "../sync/state";

/** Dosu's memory tools as Claude Code names them on the `dosu` entry `dosu mcp add` writes (other
 * servers may have tools of the same names): the matcher of the PreToolUse hook that records
 * each call's session (hooks/context.ts). */
export const CLAUDE_MEMORY_TOOL_PATTERN = "mcp__dosu__(search_memory|get_memory_evidence)";

/** The argument Dosu's OpenCode plugin and pi extension name the session with. */
export const SESSION_ARGUMENT = "_dosu_session";

/** What the proxy answers, instead of relaying, for a call from a session off the record. */
export const OFF_THE_RECORD_MESSAGE =
  "Dosu is off for this session (/dosu-incognito): the call was not sent to Dosu.";

/** What a refused call did not do, for the agent switch's messages (agentSwitchMessage). */
const CALL_NOT_SENT = "the call was not sent to Dosu";

/** How long a recorded Claude Code call waits for the proxy before it is pruned. */
const CALL_RECORD_TTL_MS = 60 * 60 * 1000;

/** Ids that are safe as one path segment. */
const SAFE_ID = /^[A-Za-z0-9._-]{1,200}$/;

export interface CallSession {
  harness: SessionHarness;
  /** The id the session's transcript ships under (Codex: its rollout's filename stem). */
  id: string;
  /** Where the session's transcript is, when known. */
  transcript: string | null;
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function str(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

/** The scanner's harness for an agent id (`claude-code` -> `claude`). */
export function harnessOfClient(client: string | undefined): SessionHarness | null {
  if (!client) return null;
  return SESSION_HARNESSES.find((h) => trajectorySourceOf(h) === client || h === client) ?? null;
}

function codexHome(): string {
  return process.env.CODEX_HOME || join(homedir(), ".codex");
}

function callRecordDir(): string {
  return join(getConfigDir(), "mcp-calls");
}

/** Claude Code's PreToolUse hook: remember which session the tool call `toolUseId` belongs to,
 * for the proxy to read when the call reaches it. Prunes records nobody read. Never throws. */
export function recordClaudeToolCall(
  toolUseId: string,
  session: { id: string; transcript: string | null },
): void {
  if (!SAFE_ID.test(toolUseId)) return;
  try {
    const dir = callRecordDir();
    mkdirSync(dir, { recursive: true });
    const now = Date.now();
    for (const name of readdirSync(dir)) {
      try {
        if (now - statSync(join(dir, name)).mtimeMs > CALL_RECORD_TTL_MS)
          unlinkSync(join(dir, name));
      } catch {
        // Gone already.
      }
    }
    writeFileSync(join(dir, `${toolUseId}.json`), JSON.stringify(session), { mode: 0o600 });
  } catch {
    // Without the record the proxy falls back to the session the server was started in.
  }
}

/** The session the PreToolUse hook recorded for `toolUseId`, consumed. */
function takeClaudeToolCall(toolUseId: string): CallSession | null {
  if (!SAFE_ID.test(toolUseId)) return null;
  const path = join(callRecordDir(), `${toolUseId}.json`);
  try {
    const record = JSON.parse(readFileSync(path, "utf-8")) as Record<string, unknown>;
    unlinkSync(path);
    const id = str(record.id);
    return id ? { harness: "claude", id, transcript: str(record.transcript) } : null;
  } catch {
    return null;
  }
}

/** The Codex session of a thread: its rollout's stem, as the ledger and the prompt hook name it. */
function codexSession(thread: string): CallSession | null {
  if (!SAFE_ID.test(thread)) return null;
  const rollout = codexRolloutOfThread(thread, codexHome());
  if (!rollout) return { harness: "codex", id: thread, transcript: null };
  return { harness: "codex", id: basename(rollout, ".jsonl"), transcript: rollout };
}

/** The variable Dosu's OpenCode plugin names the session in for the shell commands it runs
 * (opencode's `shell.env` hook); opencode sets none of its own. */
export const OPENCODE_SESSION_VARIABLE = "DOSU_OPENCODE_SESSION";

/** The variable each agent puts its session in for the shell commands it runs: Claude Code its
 * live session (also after /clear), Codex the thread the command runs for, OpenCode (through
 * Dosu's plugin) the session whose tool runs it, pi the session running the command (with its
 * transcript in PI_SESSION_FILE). */
const SHELL_SESSION_VARIABLES: ReadonlyArray<readonly [SessionHarness, string]> = [
  ["claude", "CLAUDE_CODE_SESSION_ID"],
  ["codex", "CODEX_THREAD_ID"],
  ["opencode", OPENCODE_SESSION_VARIABLE],
  ["pi", "PI_SESSION_ID"],
];

/** The agent sessions a shell command runs in, as its environment names them (`dosu memory` run
 * by an agent's model): usually one, more when an agent was started from another's shell and
 * inherited its variable. With `client`, that agent's session only. */
export function shellSessions(
  client: string | undefined,
  env: NodeJS.ProcessEnv = process.env,
): CallSession[] {
  const only = harnessOfClient(client);
  const sessions: CallSession[] = [];
  for (const [harness, variable] of SHELL_SESSION_VARIABLES) {
    const id = str(env[variable]);
    if (!id || (only && only !== harness)) continue;
    const transcript = harness === "pi" ? str(env.PI_SESSION_FILE) : null;
    const session = harness === "codex" ? codexSession(id) : { harness, id, transcript };
    if (session && SAFE_ID.test(session.id)) sessions.push(session);
  }
  return sessions;
}

/** The session a `tools/call` request's params name, read as described above for the agent
 * `client`; null when the call carries none and the agent started this server in none. Removes
 * SESSION_ARGUMENT from the arguments. */
export function takeCallSession(
  params: Record<string, unknown>,
  client: string | undefined,
  env: NodeJS.ProcessEnv = process.env,
): CallSession | null {
  const harness = harnessOfClient(client);
  const args = isObject(params.arguments) ? params.arguments : null;
  const named = args ? str(args[SESSION_ARGUMENT]) : null;
  if (args && SESSION_ARGUMENT in args) delete args[SESSION_ARGUMENT];
  if ((harness === "opencode" || harness === "pi") && named && SAFE_ID.test(named)) {
    return { harness, id: named, transcript: null };
  }

  const meta = isObject(params._meta) ? params._meta : {};
  const turn = isObject(meta["x-codex-turn-metadata"]) ? meta["x-codex-turn-metadata"] : {};
  const thread = str(turn.thread_id) ?? str(meta.threadId);
  if (thread) return codexSession(thread);

  const toolUseId = str(meta["claudecode/toolUseId"]);
  const recorded = toolUseId ? takeClaudeToolCall(toolUseId) : null;
  if (recorded) return recorded;
  const started = harness === "claude" ? str(env.CLAUDE_CODE_SESSION_ID) : null;
  if (started && SAFE_ID.test(started)) return { harness: "claude", id: started, transcript: null };
  return null;
}

/** A Claude Code session's transcript, in whichever project folder holds it. */
function claudeTranscript(id: string): string | null {
  const projects = join(claudeConfigDir(), "projects");
  let folders: string[];
  try {
    folders = readdirSync(projects);
  } catch {
    return null;
  }
  for (const folder of folders) {
    const path = join(projects, folder, `${id}.jsonl`);
    try {
      if (statSync(path).isFile()) return path;
    } catch {
      // Not in this folder.
    }
  }
  return null;
}

/** The session as the scanner would report it, when its transcript can be found. */
function storedSession(session: CallSession): AgentSession | null {
  const { harness, id } = session;
  if (!SAFE_ID.test(id)) return null;
  if (session.transcript) return sessionAtPath(harness, id, session.transcript);
  if (harness === "opencode") return opencodeSessionById(id);
  if (harness === "pi") return piSessionById(id);
  if (harness === "claude") {
    const transcript = claudeTranscript(id);
    return transcript ? sessionAtPath(harness, id, transcript) : null;
  }
  return null;
}

/** What of the sync state the agents' incognito switch is read from: the list, and the ledger
 * entries it settled (`by_agent`). */
export type IncognitoSwitch = Pick<SyncState, "incognito_agents" | "sessions">;

/** How the agents' incognito switch (`dosu knowledge incognito on`) keeps a session off the
 * record: its agent is in the list now (`agent`), or the session ran while it was, or one it
 * descends from or was branched from did (`sealed`: settled `by_agent`); null when the switch does
 * not. Its links are read off the transcript `stored` finds, when the ledger holds any such
 * session at all. With no session id, only the list can answer. */
export function agentSwitchOf(
  state: IncognitoSwitch,
  session: { harness: SessionHarness; id: string | null },
  stored: () => AgentSession | null = () => null,
): "agent" | "sealed" | null {
  const { harness, id } = session;
  if (state.incognito_agents?.includes(harness)) return "agent";
  return id !== null && isSessionAgentIncognito(state, { harness, id }, stored) ? "sealed" : null;
}

/** Why the agents' switch keeps a call on the machine (`effect`: what did not happen), for the
 * model and the user to read. Nobody ran /dosu-incognito, so an agent in incognito names the
 * command that turns the switch off; a session that ran while it was on stays off the record
 * whatever the switch says now. */
export function agentSwitchMessage(
  how: "agent" | "sealed",
  harness: SessionHarness,
  effect: string = CALL_NOT_SENT,
): string {
  return how === "agent"
    ? `Dosu is off for this agent ('dosu knowledge incognito on ${harness}'): ${effect}. Run 'dosu knowledge incognito off ${harness}' to turn it back on.`
    : `Dosu is off for this session, which ran while its agent was incognito: ${effect}.`;
}

/** What keeps the session off the record: the agents' switch (agentSwitchOf), or the user's
 * /dosu-incognito in it (`marker`), judged as its transcript's upload would be (a session whose
 * transcript cannot be found has only the switch to go by); null when nothing does. Never throws. */
function callSessionOffRecord(
  session: CallSession,
  state: IncognitoSwitch,
): "agent" | "sealed" | "marker" | null {
  try {
    let stored: AgentSession | null | undefined;
    const find = () => {
      if (stored === undefined) stored = storedSession(session);
      return stored;
    };
    const how = agentSwitchOf(state, session, find);
    if (how) return how;
    const found = find();
    return found !== null && isIncognitoSession(found) ? "marker" : null;
  } catch {
    return null;
  }
}

/** What answers a tool call in place of Dosu, or null when it may be sent: a refusal when the
 * agent `client` (the server's, or `dosu memory --client`) is in incognito, whatever session the
 * call names or whether it names one, and when a session it is made from is off the record. The
 * switch is read from knowledge-sync.json on every call, so `dosu knowledge incognito on` holds
 * from an agent's next call, without a restart. Never throws. */
export function callRefusal(
  client: string | undefined,
  sessions: readonly CallSession[],
): string | null {
  const state = loadSyncState();
  // Nothing says whether this agent, or this session, is in incognito: it may be.
  if (state.unreadable) {
    return `Dosu cannot tell whether this agent is incognito (${unreadableStateMessage()}): ${CALL_NOT_SENT}.`;
  }
  const agent = harnessOfClient(client);
  if (agent && state.incognito_agents?.includes(agent)) return agentSwitchMessage("agent", agent);
  for (const session of sessions) {
    const how = callSessionOffRecord(session, state);
    if (how === "marker") return OFF_THE_RECORD_MESSAGE;
    if (how) return agentSwitchMessage(how, session.harness);
  }
  return null;
}
