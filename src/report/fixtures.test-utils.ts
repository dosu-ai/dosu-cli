import type { EpisodeTask, MemoryListItem, SourceEffect, TraceDetail, TraceHeader } from "./types";

export function memory(id: string, overrides: Partial<MemoryListItem> = {}): MemoryListItem {
  return {
    id,
    kind: "semantic",
    title: `Memory ${id}`,
    snippet: `What ${id} says.`,
    repo: "dosu-ai/dosu",
    branch: null,
    agent: null,
    active: true,
    created_at: "2026-10-01T10:00:00Z",
    updated_at: "2026-10-01T10:00:00Z",
    retrieval_count: 0,
    episode_kind: null,
    source_count: 1,
    ...overrides,
  };
}

export function episode(id: string, overrides: Partial<MemoryListItem> = {}): MemoryListItem {
  return memory(id, { kind: "episodic", episode_kind: "hard_won_context", ...overrides });
}

export function task(ordinal: number, overrides: Partial<EpisodeTask> = {}): EpisodeTask {
  return {
    id: `task-${ordinal}`,
    ordinal,
    task_text: `Task ${ordinal}`,
    outcome: "success",
    summary: null,
    event_start: 0,
    event_end: 10,
    ...overrides,
  };
}

export function trace(
  sessionId: string,
  touched: Array<[MemoryListItem, SourceEffect[]]> = [],
  overrides: Partial<TraceDetail> & { header?: Partial<TraceHeader> } = {},
): TraceDetail {
  const { header, ...rest } = overrides;
  return {
    trace: {
      id: `trace-${sessionId}`,
      source: "claude-code",
      agent: "claude-code",
      session_id: sessionId,
      repo: "dosu-ai/dosu",
      branch: "main",
      started_at: "2026-10-01T09:00:00Z",
      ended_at: "2026-10-01T09:30:00Z",
      created_at: "2026-10-01T09:31:00Z",
      event_count: 120,
      processed_at: "2026-10-01T09:40:00Z",
      ...header,
    },
    status: "complete",
    tasks: [task(1)],
    episodes: [episode(`ep-${sessionId}`)],
    memories: touched.map(([item, effects]) => ({ item, effects })),
    ...rest,
  };
}
