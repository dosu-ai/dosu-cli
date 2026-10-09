/** Status-line rendering: the harness payload (stdin JSON) plus persisted sync state → one line
 * saying whether Dosu memory will learn from this session. Runs on every status refresh, so it
 * reads only a few small files plus the transcript, and it never throws: any failure renders as
 * off. */

import { basename } from "node:path";
import { getHookAgent } from "../hooks/agents";
import { originRepoOfDir } from "../sessions/repo";
import { SESSION_HARNESSES, sessionAtPath } from "../sessions/scan";
import { transcriptHasIncognitoMarker } from "../sync/incognito";
import {
  isSessionAgentIncognito,
  isShippingEnabled,
  isUnderDir,
  loadSyncState,
  type SyncState,
} from "../sync/state";
import { getSyncStatus } from "../sync/status";

/** In priority order: the first matching state wins. */
export type StatuslineState = "off" | "incognito" | "paused" | "not-studied" | "studying" | "on";

/** Three glyphs: on (the session ships to Dosu memory; "shipping…" only while a sync run is live,
 * matching the TUI's "shipping sessions..."), incognito (the user's own switch for this session
 * or agent), and one shared "inactive" glyph whose text says why. */
export const STATUSLINE_LABELS: Readonly<Record<StatuslineState, string>> = {
  studying: "📚 Dosu shipping…",
  on: "📚 Dosu on",
  incognito: "👻 Dosu incognito",
  paused: "⚪ Dosu paused",
  "not-studied": "⚪ Dosu not learning from this repo",
  off: "⚪ Dosu off",
};

/** The fields shared by Claude Code's and Cursor CLI's status-line payloads that we read. */
export interface StatuslinePayload {
  cwd?: string;
  transcript_path?: string;
}

export interface RenderDeps {
  /** Whether the Dosu sync hook is installed for this agent; defaults to the hook registry. */
  hookEnabled?: (agentId: string) => boolean;
  loadState?: () => SyncState;
  transcriptIsIncognito?: (path: string) => boolean;
  /** Whether a knowledge-sync run is alive right now; defaults to the sync lock file. */
  syncRunning?: () => boolean;
  repoOfDir?: (dir: string) => string | null;
}

function asString(value: unknown): string | undefined {
  return typeof value === "string" && value !== "" ? value : undefined;
}

/** Lenient parse: anything that is not a JSON object yields an empty payload. `cwd` falls back
 * to `workspace.current_dir`, which both harnesses populate with the same value. */
export function parseStatuslinePayload(raw: string): StatuslinePayload {
  try {
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return {};
    const record = parsed as Record<string, unknown>;
    const workspace =
      typeof record.workspace === "object" && record.workspace !== null
        ? (record.workspace as Record<string, unknown>)
        : {};
    const cwd = asString(record.cwd) ?? asString(workspace.current_dir);
    const transcript_path = asString(record.transcript_path);
    return {
      ...(cwd ? { cwd } : {}),
      ...(transcript_path ? { transcript_path } : {}),
    };
  } catch {
    return {};
  }
}

function defaultHookEnabled(agentId: string): boolean {
  try {
    return getHookAgent(agentId)?.isEnabled() ?? false;
  } catch {
    // Unparseable hook config: nothing is going to fire from it.
    return false;
  }
}

function defaultSyncRunning(): boolean {
  return getSyncStatus({ readLog: () => "" }).running;
}

/** Whether sessions in `cwd` get studied: everywhere without a scope, only inside a picked repo
 * with one. A legacy folder scope, not yet converted by a sync, requires a cwd under its folders. */
function cwdIsStudied(
  cwd: string | undefined,
  state: SyncState,
  repoOfDir: (dir: string) => string | null,
): boolean {
  if (state.repo_filter) {
    const repo = cwd ? repoOfDir(cwd) : null;
    return repo !== null && state.repo_filter.includes(repo);
  }
  if (state.project_filter?.length) {
    return cwd !== undefined && state.project_filter.some((base) => isUnderDir(cwd, base));
  }
  return true;
}

/** Whether the agent's saved switch keeps the payload's session off the record: the agent is in
 * incognito, or the session ran while it was (or descends from or was branched from one that did),
 * which stays so once the switch is off. The session is named by its transcript, as the scan names
 * it. */
function switchKeepsOff(payload: StatuslinePayload, agentId: string, state: SyncState): boolean {
  if (state.incognito_agents?.includes(agentId)) return true;
  const harness = SESSION_HARNESSES.find((h) => h === agentId);
  const path = payload.transcript_path;
  if (!harness || !path?.endsWith(".jsonl")) return false;
  const id = basename(path, ".jsonl");
  return isSessionAgentIncognito(state, { harness, id }, () => sessionAtPath(harness, id, path));
}

/** Incognito (the agent's saved switch, or `/dosu-incognito` in this session) outranks paused
 * and not-studied: it is the user's own action, and the line is how they confirm it took. */
export function resolveStatuslineState(
  payload: StatuslinePayload,
  agentId: string,
  deps: RenderDeps = {},
): StatuslineState {
  const hookEnabled = deps.hookEnabled ?? defaultHookEnabled;
  if (!hookEnabled(agentId)) return "off";
  const state = (deps.loadState ?? loadSyncState)();
  if (!isShippingEnabled(state)) return "off";
  if (switchKeepsOff(payload, agentId, state)) return "incognito";

  const transcriptIsIncognito = deps.transcriptIsIncognito ?? transcriptHasIncognitoMarker;
  if (payload.transcript_path && transcriptIsIncognito(payload.transcript_path)) {
    return "incognito";
  }

  if (state.paused) return "paused";
  if (!cwdIsStudied(payload.cwd, state, deps.repoOfDir ?? originRepoOfDir)) return "not-studied";
  return (deps.syncRunning ?? defaultSyncRunning)() ? "studying" : "on";
}

/** The installed command's whole job: stdin payload + agent id → one line. Never throws. */
export function renderStatusline(raw: string, agentId: string, deps: RenderDeps = {}): string {
  try {
    return STATUSLINE_LABELS[resolveStatuslineState(parseStatuslinePayload(raw), agentId, deps)];
  } catch {
    return STATUSLINE_LABELS.off;
  }
}
