/** Status-line rendering: the harness payload (stdin JSON) plus persisted sync state → one line
 * saying whether this session is being studied. Runs on every status refresh, so it reads only
 * a few small files plus the transcript, and it never throws: any failure renders as off. */

import { getHookAgent } from "../hooks/agents";
import { transcriptHasIncognitoMarker } from "../sync/incognito";
import { getSyncStatus } from "../sync/status";
import { isUnderDir, loadSyncState, type SyncState, UNKNOWN_PROJECT } from "../sync/watermark";

/** In priority order: the first matching state wins. */
export type StatuslineState = "off" | "incognito" | "paused" | "not-studied" | "studying" | "on";

/** Three glyphs: studying/on (the session will be studied; "studying…" only while a run is live,
 * matching the TUI), incognito (the user's own switch for this session), and one shared
 * "inactive" glyph whose text says why. */
export const STATUSLINE_LABELS: Readonly<Record<StatuslineState, string>> = {
  studying: "📚 Dosu studying…",
  on: "📚 Dosu on",
  incognito: "👻 Dosu incognito",
  paused: "⚪ Dosu paused",
  "not-studied": "⚪ Dosu not studying this folder",
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

/** Whether `cwd` falls inside the studied directories; a missing cwd is the unknown bucket. */
function cwdIsStudied(cwd: string | undefined, filter: readonly string[] | undefined): boolean {
  if (!filter || filter.length === 0) return true;
  if (!cwd) return filter.includes(UNKNOWN_PROJECT);
  return filter.some((base) => base !== UNKNOWN_PROJECT && isUnderDir(cwd, base));
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
  if (state.incognito_agents?.includes(agentId)) return "incognito";

  const transcriptIsIncognito = deps.transcriptIsIncognito ?? transcriptHasIncognitoMarker;
  if (payload.transcript_path && transcriptIsIncognito(payload.transcript_path)) {
    return "incognito";
  }

  if (state.paused) return "paused";
  if (!cwdIsStudied(payload.cwd, state.project_filter)) return "not-studied";
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
