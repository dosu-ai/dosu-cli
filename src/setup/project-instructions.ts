import { existsSync, lstatSync, readFileSync, realpathSync } from "node:fs";
import { dirname, join } from "node:path";
import { removeProjectFile, writeProjectFile } from "../mcp/config-helpers";
import { DOSU_SECTION_END, upsertDosuAgentsSection } from "./agents-md-step";
import { assertSafeProjectPath } from "./project-path";

export const PROJECT_ADAPTER_START = "<!-- dosu:project-instructions:start v1 -->";
export const PROJECT_ADAPTER_END = "<!-- dosu:project-instructions:end -->";

const DOSU_SECTION_START_RE = /<!-- dosu:mcp:start(?: v\d+)? -->/;

export type ProjectInstructionAction =
  | "created"
  | "updated"
  | "unchanged"
  | "removed"
  | "not_found";

export interface ProjectInstructionAdapterResult {
  provider: string;
  path: string;
  action: ProjectInstructionAction;
}

export interface ProjectInstructionsResult {
  agentsMd: ReturnType<typeof upsertDosuAgentsSection>;
  adapters: ProjectInstructionAdapterResult[];
}

export function providerUsesProjectInstructions(providerID: string): boolean {
  return providerID !== "mcporter";
}

interface ProjectAdapter {
  provider: "claude" | "gemini" | "antigravity";
  path(projectRoot: string): string;
  body(content: string): string;
}

const PROJECT_ADAPTERS: readonly ProjectAdapter[] = [
  {
    provider: "claude",
    path: (root) => join(root, "CLAUDE.md"),
    body: () => "@AGENTS.md",
  },
  {
    provider: "gemini",
    path: (root) => join(root, "GEMINI.md"),
    body: () => "@AGENTS.md",
  },
  {
    provider: "antigravity",
    path: (root) => join(root, ".agents", "rules", "dosu.md"),
    body: (content) => content.trim(),
  },
];

function atomicProjectWrite(path: string, content: string, expectedContent: string | null): void {
  writeProjectFile(path, content, expectedContent);
}

function block(body: string, eol: "\n" | "\r\n"): string {
  return `${PROJECT_ADAPTER_START}${eol}${body.trim().replace(/\r?\n/g, eol)}${eol}${PROJECT_ADAPTER_END}`;
}

function locateAdapter(content: string): { start: number; end: number } | null {
  const start = content.indexOf(PROJECT_ADAPTER_START);
  const end = content.indexOf(PROJECT_ADAPTER_END);
  if (start === -1 && end === -1) return null;
  if (start === -1 || end < start) {
    throw new Error("Dosu project instruction markers are incomplete; refusing to modify the file");
  }
  if (
    content.indexOf(PROJECT_ADAPTER_START, start + PROJECT_ADAPTER_START.length) !== -1 ||
    content.indexOf(PROJECT_ADAPTER_END, end + PROJECT_ADAPTER_END.length) !== -1
  ) {
    throw new Error(
      "Multiple Dosu project instruction marker blocks found; refusing to modify the file",
    );
  }
  return { start, end: end + PROJECT_ADAPTER_END.length };
}

function pointsToCanonicalAgents(path: string, projectRoot: string): boolean {
  try {
    return (
      lstatSync(path).isSymbolicLink() &&
      realpathSync(path) === realpathSync(join(projectRoot, "AGENTS.md"))
    );
  } catch {
    return false;
  }
}

function upsertAdapter(
  path: string,
  body: string,
  projectRoot: string,
  allowAgentsSymlink: boolean,
): ProjectInstructionAction {
  if (existsSync(path) && lstatSync(path).isSymbolicLink()) {
    if (allowAgentsSymlink && pointsToCanonicalAgents(path, projectRoot)) return "unchanged";
    throw new Error(`Refusing to modify symbolic link at ${path}`);
  }
  const existed = existsSync(path);
  const existing = existed ? readFileSync(path, "utf8") : "";
  const eol = existing.includes("\r\n") ? "\r\n" : "\n";
  const nextBlock = block(body, eol);
  const location = locateAdapter(existing);
  let next: string;
  if (location) {
    next = `${existing.slice(0, location.start)}${nextBlock}${existing.slice(location.end)}`;
  } else if (existing) {
    next = `${existing.trimEnd()}${eol}${eol}${nextBlock}${eol}`;
  } else {
    next = `${nextBlock}${eol}`;
  }
  if (next === existing) return "unchanged";
  atomicProjectWrite(path, next, existed ? existing : null);
  return existing ? "updated" : "created";
}

function adapterFor(provider: string): ProjectAdapter | undefined {
  return PROJECT_ADAPTERS.find((adapter) => adapter.provider === provider);
}

export function installProjectInstructions(input: {
  projectRoot: string;
  providerIDs: readonly string[];
  content: string;
}): ProjectInstructionsResult {
  const agentsPath = join(input.projectRoot, "AGENTS.md");
  assertSafeProjectPath(input.projectRoot, agentsPath);
  if (existsSync(agentsPath) && lstatSync(agentsPath).isSymbolicLink()) {
    throw new Error(`Refusing to modify symbolic link at ${agentsPath}`);
  }
  const plannedAdapters = [...new Set(input.providerIDs)].flatMap((provider) => {
    const adapter = adapterFor(provider);
    if (!adapter) return [];
    const path = adapter.path(input.projectRoot);
    const allowAgentsSymlink = adapter.provider === "claude" || adapter.provider === "gemini";
    if (allowAgentsSymlink && existsSync(path) && lstatSync(path).isSymbolicLink()) {
      assertSafeProjectPath(input.projectRoot, dirname(path));
    } else {
      assertSafeProjectPath(input.projectRoot, path);
    }
    return [{ provider, adapter, path }];
  });
  const agentsMd = upsertDosuAgentsSection(input.projectRoot, input.content);
  const adapters: ProjectInstructionAdapterResult[] = [];
  for (const { provider, adapter, path } of plannedAdapters) {
    adapters.push({
      provider,
      path,
      action: upsertAdapter(
        path,
        adapter.body(input.content),
        input.projectRoot,
        adapter.provider === "claude" || adapter.provider === "gemini",
      ),
    });
  }
  return { agentsMd, adapters };
}

function hasCompleteAgentsSection(path: string): boolean {
  if (!existsSync(path)) return false;
  const content = readFileSync(path, "utf8");
  const start = content.search(DOSU_SECTION_START_RE);
  const end = content.indexOf(DOSU_SECTION_END, Math.max(start, 0));
  return start >= 0 && end > start;
}

function hasCompleteAdapter(
  path: string,
  projectRoot: string,
  allowAgentsSymlink: boolean,
): boolean {
  if (!existsSync(path)) return false;
  if (lstatSync(path).isSymbolicLink()) {
    return allowAgentsSymlink && pointsToCanonicalAgents(path, projectRoot);
  }
  try {
    return locateAdapter(readFileSync(path, "utf8")) !== null;
  } catch {
    return false;
  }
}

export function verifyProjectInstructions(
  projectRoot: string,
  providerIDs: readonly string[],
): boolean {
  if (!hasCompleteAgentsSection(join(projectRoot, "AGENTS.md"))) return false;
  return [...new Set(providerIDs)].every((provider) => {
    const adapter = adapterFor(provider);
    return (
      !adapter ||
      hasCompleteAdapter(
        adapter.path(projectRoot),
        projectRoot,
        adapter.provider === "claude" || adapter.provider === "gemini",
      )
    );
  });
}

function removeAdapter(path: string): ProjectInstructionAction {
  if (!existsSync(path)) return "not_found";
  if (lstatSync(path).isSymbolicLink()) return "not_found";
  const existing = readFileSync(path, "utf8");
  const location = locateAdapter(existing);
  if (!location) return "not_found";
  const before = existing.slice(0, location.start);
  const after = existing.slice(location.end);
  const next = `${before}${after}`;
  const eol = existing.includes("\r\n") ? "\r\n" : "\n";
  if (before === "" && after === eol) removeProjectFile(path, existing);
  else atomicProjectWrite(path, next, existing);
  return "removed";
}

export function removeProjectInstructionAdapters(
  projectRoot: string,
  providerIDs: readonly string[],
): ProjectInstructionAdapterResult[] {
  return [...new Set(providerIDs)].flatMap((provider) => {
    const adapter = adapterFor(provider);
    if (!adapter) return [];
    const path = adapter.path(projectRoot);
    if (existsSync(path) && lstatSync(path).isSymbolicLink()) {
      assertSafeProjectPath(projectRoot, dirname(path));
    } else {
      assertSafeProjectPath(projectRoot, path);
    }
    return [{ provider, path, action: removeAdapter(path) }];
  });
}
