/** Shapes of the memory browser's session lineage (`GET /v1/memory/browse/sessions/{id}`), as
 * the backend sends them, plus the report model built from them. The web app's session page
 * renders the same payload; the report mirrors its sections across many sessions. */

export type MemoryKind = "semantic" | "procedural" | "episodic";
export type EpisodeKind = "hard_won_context" | "human_feedback" | "mistake";
export type SourceEffect = "created" | "updated" | "confirmed" | "contradicted";
export type TaskOutcome = "success" | "partial" | "failed" | "abandoned";

export interface MemoryListItem {
  id: string;
  kind: MemoryKind;
  title: string;
  snippet: string;
  repo: string | null;
  branch: string | null;
  agent: string | null;
  active: boolean;
  created_at: string;
  updated_at: string;
  retrieval_count: number;
  episode_kind: EpisodeKind | null;
  source_count: number | null;
  redacted?: boolean;
}

export interface EpisodeTask {
  id: string;
  ordinal: number;
  task_text: string | null;
  outcome: TaskOutcome;
  summary: string | null;
  event_start: number;
  event_end: number;
}

export interface TraceHeader {
  id: string;
  source: string;
  agent: string;
  session_id: string | null;
  repo: string;
  branch: string | null;
  started_at: string | null;
  ended_at: string | null;
  created_at: string;
  event_count: number;
  processed_at?: string | null;
}

interface TouchedMemory {
  item: MemoryListItem;
  effects: SourceEffect[];
}

export interface TraceDetail {
  trace: TraceHeader;
  status: "processing" | "complete";
  tasks: EpisodeTask[];
  episodes: MemoryListItem[];
  memories: TouchedMemory[];
}

export interface SessionDetail {
  session_id: string;
  traces: TraceDetail[];
  private_traces: number;
}

/** One shipped session as the report sees it. `waiting`: shipped but not ingested yet;
 * `private`: ingested only under another account; `error`: the lookup failed. */
export interface ReportSession {
  sessionId: string;
  harness: string;
  project?: string;
  shippedAt: string;
  state: "complete" | "processing" | "waiting" | "private" | "error";
  /** The newest of the caller's ingests of this session, when there is one. */
  trace?: TraceDetail;
  error?: string;
}

/** A memory touched by one or more of the report's sessions. */
export interface ReportMemory {
  item: MemoryListItem;
  /** Distinct effects across all sessions, in first-seen order. */
  effects: SourceEffect[];
  /** Session ids that touched it, in report order. */
  sessionIds: string[];
}

export interface ReportTotals {
  sessions: number;
  processed: number;
  tasks: number;
  episodes: number;
  memories: number;
  created: number;
  updated: number;
  confirmed: number;
  contradicted: number;
}

export interface Report {
  generatedAt: string;
  days: number;
  orgName: string;
  appUrl: string;
  sessions: ReportSession[];
  memories: ReportMemory[];
  totals: ReportTotals;
}
