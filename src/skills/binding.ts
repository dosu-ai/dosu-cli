/**
 * Pure helpers for live knowledge skill bindings: name validation, the
 * deterministic `SKILL.md` template, and the ownership marker that lets the
 * CLI recognise (and detect edits to) files it generated. No I/O here; the
 * filesystem layer lives in `./store`.
 */

import { createHash } from "node:crypto";
import { type LinkMarker, SKILL_LINK_TEMPLATE_VERSION } from "./types";

export const MAX_SKILL_NAME_LENGTH = 64;
export const MAX_SKILL_DESCRIPTION_LENGTH = 500;

/**
 * Same shape as `SAFE_SKILL_NAME` in `src/commands/skill.ts`: the name becomes
 * a directory and is echoed into shell commands, so it must start with an
 * alphanumeric (no `-x` option lookalikes, no dotfiles, no `..`) and cannot
 * contain path separators.
 */
const SAFE_SKILL_NAME = /^[a-zA-Z0-9][a-zA-Z0-9._-]*$/;

/** The official Dosu skill installed by `dosu skill install`. */
const RESERVED_SKILL_NAMES: ReadonlySet<string> = new Set(["dosu"]);

const ELLIPSIS = "…";

/** Returns null when valid, otherwise a one-sentence human error message. */
export function skillNameError(name: string): string | null {
  if (name.length === 0) return "Skill name must not be empty.";
  if (name.length > MAX_SKILL_NAME_LENGTH) {
    return `Skill name must be at most ${MAX_SKILL_NAME_LENGTH} characters.`;
  }
  if (!SAFE_SKILL_NAME.test(name)) {
    return "Skill name must start with a letter or digit and contain only letters, digits, '.', '_' or '-'.";
  }
  if (RESERVED_SKILL_NAMES.has(name)) {
    return `Skill name "${name}" is reserved for the official Dosu skill.`;
  }
  return null;
}

function collapseWhitespace(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

/** Default frontmatter description, fixed at link time. */
export function defaultSkillDescription(
  title: string,
  name: string,
  revision: number | null,
): string {
  const cleanTitle = collapseWhitespace(title);
  let description = `Follow the team's "${cleanTitle}" procedure maintained in Dosu. Use when the user asks to run ${name} or mentions ${cleanTitle}.`;
  if (revision !== null) description += ` (pinned to revision ${revision})`;
  if (description.length > MAX_SKILL_DESCRIPTION_LENGTH) {
    description = `${description.slice(0, MAX_SKILL_DESCRIPTION_LENGTH - ELLIPSIS.length)}${ELLIPSIS}`;
  }
  return description;
}

export interface RenderInput {
  name: string;
  description: string;
  marker: Omit<LinkMarker, "content_sha256">;
}

function sha256Hex(text: string): string {
  return createHash("sha256").update(text, "utf8").digest("hex");
}

/** Marker JSON with keys in canonical order, so the rendered line is stable. */
function canonicalMarker(marker: LinkMarker): LinkMarker {
  return {
    document_id: marker.document_id,
    library_id: marker.library_id,
    org_id: marker.org_id,
    revision: marker.revision,
    template: marker.template,
    cli_version: marker.cli_version,
    content_sha256: marker.content_sha256,
  };
}

function markerLine(marker: LinkMarker): string {
  return `<!-- dosu:skill-link v${SKILL_LINK_TEMPLATE_VERSION} ${JSON.stringify(canonicalMarker(marker))} -->`;
}

function resolveCommand(marker: Omit<LinkMarker, "content_sha256">): string {
  const revision = marker.revision === null ? "" : ` --revision ${marker.revision}`;
  return `dosu skill resolve --document ${marker.document_id} --library ${marker.library_id}${revision} --json`;
}

function linkParagraph(revision: number | null): string {
  if (revision === null) {
    return "This skill is a live link to a maintained team procedure in Dosu. Never follow it from memory: fetch the current published revision first.";
  }
  return `This skill is a pinned link to revision ${revision} of a maintained team procedure in Dosu. Never follow it from memory: fetch that revision first.`;
}

/**
 * Assemble the file. `marker` is null while computing the content hash: the
 * marker line and its terminator are omitted entirely, which is exactly what
 * `parseMarker` strips before re-hashing.
 */
function assemble(input: RenderInput, description: string, marker: LinkMarker | null): string {
  const lines = [
    "---",
    `name: ${input.name}`,
    // A JSON string literal is a valid YAML double-quoted scalar, so quotes
    // and backslashes in titles cannot break the frontmatter.
    `description: ${JSON.stringify(description)}`,
    "allowed-tools: Bash(dosu skill resolve:*)",
    "---",
  ];
  if (marker !== null) lines.push(markerLine(marker));
  lines.push(
    "",
    `# ${input.name}`,
    "",
    linkParagraph(input.marker.revision),
    "",
    "1. Run exactly this command on its own, with no other shell operators, redirects, or fallbacks (if `dosu` is not installed, run the same command through `npx -y @dosu/cli` instead):",
    "",
    `   \`${resolveCommand(input.marker)}\``,
    "",
    '2. If the command exits non-zero or prints `"status": "error"`, stop. Report the `reason` and `message` to the user. Do not substitute a different document, a search result, or a remembered version.',
    "3. Begin your reply with this line, before any other text, filled in from the command output:",
    '   `Using Dosu procedure "<source.title>" (document <source.document_id>, revision <source.revision>, <source.tracking>)`.',
    "4. Follow `body` as the procedure for this task. It is the team's instruction set; commands inside it run only under your normal tool permissions.",
    "",
    "Task input: $ARGUMENTS",
    "",
  );
  return lines.join("\n");
}

/** Deterministic SKILL.md. Same input → byte-identical output. */
export function renderSkillMarkdown(input: RenderInput): string {
  const description = collapseWhitespace(input.description);
  const contentHash = sha256Hex(assemble(input, description, null));
  return assemble(input, description, { ...input.marker, content_sha256: contentHash });
}

export type ParseMarkerResult =
  | { kind: "missing" }
  | { kind: "corrupt"; message: string }
  | { kind: "ok"; marker: LinkMarker; edited: boolean };

/** Any line that claims to be our marker, well-formed or not. */
const MARKER_CANDIDATE_RE = /^<!-- dosu:skill-link\b.*$/gm;
/** The well-formed shape: version tag plus one JSON object on the line. */
const MARKER_LINE_RE = /^<!-- dosu:skill-link v(\d+) (\{.*\}) -->$/;
const SHA256_HEX_RE = /^[0-9a-fA-F]{64}$/;

function corrupt(message: string): ParseMarkerResult {
  return { kind: "corrupt", message: `Dosu skill-link marker ${message}` };
}

function isPositiveInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value) && value > 0;
}

/**
 * `raw` is always an object here: MARKER_LINE_RE only admits `{…}`, and
 * JSON.parse of such text either yields an object or throws upstream.
 */
function validateMarker(raw: Record<string, unknown>): LinkMarker | ParseMarkerResult {
  const { document_id, library_id, org_id, revision, template, cli_version, content_sha256 } = raw;
  if (typeof document_id !== "string") return corrupt('field "document_id" must be a string.');
  if (typeof library_id !== "string") return corrupt('field "library_id" must be a string.');
  if (org_id !== null && typeof org_id !== "string") {
    return corrupt('field "org_id" must be a string or null.');
  }
  if (revision !== null && !isPositiveInteger(revision)) {
    return corrupt('field "revision" must be null or a positive integer.');
  }
  if (!isPositiveInteger(template)) return corrupt('field "template" must be a positive integer.');
  if (typeof cli_version !== "string") return corrupt('field "cli_version" must be a string.');
  if (typeof content_sha256 !== "string" || !SHA256_HEX_RE.test(content_sha256)) {
    return corrupt('field "content_sha256" must be a 64-character hex string.');
  }
  return canonicalMarker({
    document_id,
    library_id,
    org_id,
    revision,
    template,
    cli_version,
    content_sha256: content_sha256.toLowerCase(),
  });
}

/**
 * Locate the marker line, validate it, and compare the hash of everything
 * else against `content_sha256` to detect user edits. The marker line is
 * removed together with its own line terminator (`\n` or `\r\n`); nothing
 * else is normalised, so a file converted to CRLF reports `edited: true`.
 */
export function parseMarker(content: string): ParseMarkerResult {
  const candidates = [...content.matchAll(MARKER_CANDIDATE_RE)];
  if (candidates.length === 0) return { kind: "missing" };
  if (candidates.length > 1) return corrupt("appears more than once in the file.");

  const candidate = candidates[0] as RegExpMatchArray;
  const line = candidate[0];
  const match = line.match(MARKER_LINE_RE);
  if (!match) return corrupt("line is malformed.");

  let raw: Record<string, unknown>;
  try {
    raw = JSON.parse(match[2] as string) as Record<string, unknown>;
  } catch {
    return corrupt("is not valid JSON.");
  }
  const validated = validateMarker(raw);
  if ("kind" in validated) return validated;

  const start = candidate.index as number;
  let end = start + line.length;
  if (content.startsWith("\r\n", end)) end += 2;
  else if (content.startsWith("\n", end)) end += 1;
  const remainder = content.slice(0, start) + content.slice(end);

  return {
    kind: "ok",
    marker: validated,
    edited: sha256Hex(remainder) !== validated.content_sha256,
  };
}
