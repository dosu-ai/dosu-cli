/** Shapes matching the log-to-dosu-knowledge generate_report.py inputs. */

interface ReportTranscript {
  source: string;
  transcript_id: string;
  /** First user query, tags stripped — shown instead of the UUID. */
  title?: string;
  learning_tokens: number;
  rediscovery_tool_calls?: number;
  user_queries?: string[];
}

export interface ReportInventory {
  cwd?: string;
  transcripts: ReportTranscript[];
  totals?: { learning_tokens: number };
}

/** One write_knowledge payload, plus report-only helper fields. */
export interface ReportCandidate {
  title?: string;
  content?: string;
  transcript_id?: string;
  session_title?: string;
  repo?: string;
  branch?: string;
  status?: string;
  approx_rediscovery_tokens?: number | null;
  investigation_lines?: string;
  plain_english?: string;
  how_found?: string;
  user_query?: string;
  baseline_tokens?: number;
}

export interface DigestTool {
  name?: string;
  path?: string;
  pattern?: string;
  command_preview?: string;
  query?: string;
  file_path?: string;
  prompt?: string;
  arguments?: Record<string, unknown>;
  toolName?: string;
  tool_name?: string;
  server?: string;
  knowledge?: { tool?: string; arguments?: Record<string, unknown> };
}

export interface DigestTurn {
  role?: string;
  line?: number;
  est_tokens?: number;
  text?: string | string[];
  tools?: DigestTool[];
}

export interface ReportDigest {
  turns: DigestTurn[];
}

/** One knowledge note as the report consumes it. The backend is the single
 * source of truth: `transcript_id` is the agent conversation the note was
 * learned from, injected at the miner's tool gate at write time. */
export interface ReportNote {
  title: string;
  content: string;
  transcript_id?: string;
  repo?: string;
  branch?: string;
  /** ISO write time, for chronological ordering. */
  at?: string;
}
