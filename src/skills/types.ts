/**
 * Shared types for live knowledge skills (`dosu skill link|resolve|links|unlink`).
 *
 * A "binding" is a generated `SKILL.md` that points a coding agent at one Dosu
 * document. The resolver fetches that document's highest published revision
 * (or a pinned revision) at invocation time, so editing the document in Dosu
 * changes what every agent using the skill does.
 */

/** Coding agents that can host a linked skill. Claude Code only in v1. */
export type SkillAgent = "claude";

/** Where the skill directory lives: the agent's user config dir or `<cwd>/.claude/skills`. */
export type SkillScope = "user" | "project";

/** `live` follows the highest published revision; `pinned` is fixed to one revision. */
export type SkillTracking = "live" | "pinned";

/** Current generated-file template version. Bump when the rendered SKILL.md changes shape. */
export const SKILL_LINK_TEMPLATE_VERSION = 1;

/**
 * Ownership + provenance marker embedded in the generated SKILL.md as an HTML
 * comment. `content_sha256` is the SHA-256 (hex) of the file with the marker
 * line removed, so user edits to the generated file can be detected.
 */
export interface LinkMarker {
  document_id: string;
  library_id: string;
  org_id: string | null;
  /** `null` = live tracking; a number = pinned to that revision. */
  revision: number | null;
  template: number;
  cli_version: string;
  content_sha256: string;
}

/** Everything the resolver learned about the document revision it returned. */
export interface ResolvedSource {
  document_id: string;
  title: string;
  revision: number;
  page_version_id: string;
  published: true;
  tracking: SkillTracking;
  library_id: string;
  knowledge_store_id: string;
  updated_at: string;
  fetched_at: string;
}

/** Machine-readable failure classes. Every failure exits 1. */
export type ResolveReason =
  | "library_mismatch"
  | "knowledge_store_missing"
  | "document_not_found"
  | "no_published_revision"
  | "revision_unavailable"
  | "revision_not_published"
  | "document_archived"
  | "empty_body"
  | "resolver_inconsistency"
  | "procedure_too_large"
  | "access_denied"
  | "network_error"
  | "unexpected_error";

export interface ResolveFailure {
  ok: false;
  reason: ResolveReason;
  /** Human-readable, one sentence, safe to print. */
  message: string;
  /** What the calling agent should tell the user / do next. */
  agent_next_steps: string;
  /** Optional structured details (ids, sizes) for programmatic consumers. */
  details?: Record<string, unknown>;
}

export interface ResolveSuccess {
  ok: true;
  source: ResolvedSource;
  body: string;
}

export type ResolveResult = ResolveSuccess | ResolveFailure;

/** One binding found on disk by `dosu skill links`. */
export interface LinkedSkillEntry {
  name: string;
  agent: SkillAgent;
  scope: SkillScope;
  path: string;
  marker: LinkMarker;
  /** True when the file's content hash no longer matches the marker (user edited it). */
  edited: boolean;
}
