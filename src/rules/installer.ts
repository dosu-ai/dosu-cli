/**
 * Agent rule installation.
 *
 * This follows Context7 CLI's file-vs-marker strategy:
 * - Claude Code and Cursor get standalone rule files.
 * - Codex, OpenCode, Gemini CLI, and Antigravity get a marker-delimited
 *   section in the instruction file their agent already reads.
 *
 * The canonical rule is fetched from GitHub during setup, with a bundled
 * fallback so a transient network failure never prevents installation.
 */

import { existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { assertSafeProjectPath } from "../setup/project-root";

export type RuleAgentID = "claude" | "cursor" | "codex" | "opencode" | "gemini" | "antigravity";

type RuleTarget =
  | {
      kind: "file";
      path: (projectRoot?: string) => string | null;
      cursorFrontmatter?: boolean;
    }
  | {
      kind: "section";
      path: (projectRoot?: string) => string | null;
    };

export type RuleAction = "created" | "updated" | "unchanged" | "removed" | "not_found";

export interface RuleResult {
  agent: RuleAgentID;
  path: string;
  action: RuleAction;
}

const DOSU_RULE_SECTION_VERSION = 1;
export const DOSU_RULE_SECTION_START = `<!-- dosu:rules:start v${DOSU_RULE_SECTION_VERSION} -->`;
export const DOSU_RULE_SECTION_END = "<!-- dosu:rules:end -->";

const DOSU_RULE_SECTION_START_RE = /<!-- dosu:rules:start(?: v\d+)? -->/;
const CURSOR_FRONTMATTER = "---\nalwaysApply: true\n---\n\n";

export const DOSU_RULE_URLS = [
  "https://raw.githubusercontent.com/dosu-ai/dosu-cli/main/rules/dosu.md",
  "https://raw.githubusercontent.com/dosu-ai/dosu-cli/master/rules/dosu.md",
] as const;

export const FALLBACK_DOSU_RULE = `The team you are assisting maintains shared knowledge in Dosu: consult it to build on prior work, and contribute durable knowledge so future teammates and agents do not have to rediscover it. Always use only tools currently listed by the server.

When \`read_knowledge\` is listed, call it before non-trivial code or documentation work involving architecture, conventions, prior decisions, gotchas, incidents, ownership, or branch history. **If unsure whether relevant context exists, read first.** Pass \`repo\` and \`branch\` when available. Skip generic questions, trivial or self-contained edits, and context already injected by Dosu.

When \`write_knowledge\` is listed, use it after the task for durable, non-obvious knowledge that future work would otherwise have to rediscover. Do not save task or PR summaries, progress, test results, obvious facts, speculation, duplicates, or sensitive data. **If nothing durable was learned, do not write.**

Use \`review_knowledge\` only when the user asks to inspect or manage pending knowledge. Preview one item at a time and require explicit confirmation before making changes.

When \`read_knowledge\` or \`write_knowledge\` returned a \`receipt_item_id\` this turn, call \`finalize_session_knowledge\` exactly once at the end of the turn — after completing the task, immediately before your final reply — passing all receipt_item_ids from this turn. Never call it when the current turn produced no receipt_item_id, and never call it more than once per turn.
`;

function claudeConfigDir(): string {
  return process.env.CLAUDE_CONFIG_DIR || join(homedir(), ".claude");
}

function codexHome(): string {
  return process.env.CODEX_HOME || join(homedir(), ".codex");
}

const RULE_TARGETS: Record<RuleAgentID, RuleTarget> = {
  claude: {
    kind: "file",
    path: (root) =>
      root
        ? join(root, ".claude", "rules", "dosu.md")
        : join(claudeConfigDir(), "rules", "dosu.md"),
  },
  cursor: {
    kind: "file",
    path: (root) =>
      root
        ? join(root, ".cursor", "rules", "dosu.mdc")
        : join(homedir(), ".cursor", "rules", "dosu.mdc"),
    cursorFrontmatter: true,
  },
  codex: {
    kind: "section",
    // Project setup writes the canonical root AGENTS.md separately.
    path: (root) => (root ? null : join(codexHome(), "AGENTS.md")),
  },
  opencode: {
    kind: "section",
    // OpenCode also reads the canonical project AGENTS.md.
    path: (root) => (root ? null : join(homedir(), ".config", "opencode", "AGENTS.md")),
  },
  gemini: {
    kind: "section",
    path: (root) => (root ? join(root, "GEMINI.md") : join(homedir(), ".gemini", "GEMINI.md")),
  },
  antigravity: {
    kind: "section",
    path: (root) => (root ? null : join(homedir(), ".gemini", "GEMINI.md")),
  },
};

export function isRuleAgent(agent: string): agent is RuleAgentID {
  return Object.hasOwn(RULE_TARGETS, agent);
}

export function rulePathForAgent(agent: string, projectRoot?: string): string | null {
  return isRuleAgent(agent) ? RULE_TARGETS[agent].path(projectRoot) : null;
}

function normalizeRule(content: string): string {
  return `${content.trim()}\n`;
}

export async function fetchDosuRule(
  fetchImpl: typeof globalThis.fetch = globalThis.fetch,
): Promise<string> {
  for (const url of DOSU_RULE_URLS) {
    try {
      const response = await fetchImpl(url);
      if (!response.ok) continue;
      const content = await response.text();
      if (content.trim()) return normalizeRule(content);
    } catch {
      // Try the next source, then fall back to the bundled rule.
    }
  }
  return normalizeRule(FALLBACK_DOSU_RULE);
}

function ensureParent(path: string): void {
  mkdirSync(dirname(path), { recursive: true });
}

function writeIfChanged(path: string, content: string): RuleAction {
  if (!existsSync(path)) {
    ensureParent(path);
    writeFileSync(path, content, "utf-8");
    return "created";
  }

  if (readFileSync(path, "utf-8") === content) return "unchanged";
  writeFileSync(path, content, "utf-8");
  return "updated";
}

function findSection(content: string): { start: number; end: number } | null {
  const startMatch = content.match(DOSU_RULE_SECTION_START_RE);
  const start = startMatch?.index ?? -1;
  const end = content.indexOf(DOSU_RULE_SECTION_END, Math.max(start, 0));

  if (start === -1 && end === -1) return null;
  if (start === -1 || end < start) {
    throw new Error("Dosu rule markers are incomplete; refusing to overwrite the instruction file");
  }
  return { start, end };
}

function lineEndingFor(content: string): "\r\n" | "\n" {
  return content.includes("\r\n") ? "\r\n" : "\n";
}

function buildSection(content: string, lineEnding: "\r\n" | "\n" = "\n"): string {
  const body = content.trimEnd().replace(/\r?\n/g, lineEnding);
  return `${DOSU_RULE_SECTION_START}${lineEnding}${body}${lineEnding}${DOSU_RULE_SECTION_END}`;
}

function upsertSection(path: string, content: string): RuleAction {
  if (!existsSync(path)) {
    const section = buildSection(content);
    ensureParent(path);
    writeFileSync(path, `${section}\n`, "utf-8");
    return "created";
  }

  const existing = readFileSync(path, "utf-8");
  const lineEnding = lineEndingFor(existing);
  const section = buildSection(content, lineEnding);
  const location = findSection(existing);
  let next: string;

  if (location) {
    next =
      existing.slice(0, location.start) +
      section +
      existing.slice(location.end + DOSU_RULE_SECTION_END.length);
  } else {
    const separator =
      existing.length > 0 && !existing.endsWith(lineEnding)
        ? `${lineEnding}${lineEnding}`
        : existing.length > 0
          ? lineEnding
          : "";
    next = `${existing}${separator}${section}${lineEnding}`;
  }

  if (next === existing) return "unchanged";
  writeFileSync(path, next, "utf-8");
  return "updated";
}

export function installRuleForAgent(
  agent: string,
  content: string,
  projectRoot?: string,
): RuleResult | null {
  if (!isRuleAgent(agent)) return null;

  const target = RULE_TARGETS[agent];
  const path = target.path(projectRoot);
  if (!path) return null;
  if (projectRoot) assertSafeProjectPath(projectRoot, path);
  const normalized = normalizeRule(content);
  const action =
    target.kind === "file"
      ? writeIfChanged(
          path,
          target.cursorFrontmatter ? `${CURSOR_FRONTMATTER}${normalized}` : normalized,
        )
      : upsertSection(path, normalized);

  return { agent, path, action };
}

export function removeRuleForAgent(agent: string, projectRoot?: string): RuleResult | null {
  if (!isRuleAgent(agent)) return null;

  const target = RULE_TARGETS[agent];
  const path = target.path(projectRoot);
  if (!path) return null;
  if (projectRoot) assertSafeProjectPath(projectRoot, path);
  if (!existsSync(path)) return { agent, path, action: "not_found" };

  if (target.kind === "file") {
    unlinkSync(path);
    return { agent, path, action: "removed" };
  }

  const existing = readFileSync(path, "utf-8");
  const lineEnding = lineEndingFor(existing);
  const location = findSection(existing);
  if (!location) return { agent, path, action: "not_found" };

  const next = (
    existing.slice(0, location.start) + existing.slice(location.end + DOSU_RULE_SECTION_END.length)
  )
    .replace(/(?:\r?\n){3,}/g, `${lineEnding}${lineEnding}`)
    .replace(/^(?:\r?\n)+/, "")
    .trimEnd();

  if (!next) {
    unlinkSync(path);
  } else {
    writeFileSync(path, `${next}${lineEnding}`, "utf-8");
  }
  return { agent, path, action: "removed" };
}
