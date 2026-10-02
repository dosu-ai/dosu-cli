/** Project keys: the identity of the codebase a session worked in, which Dosu memory scopes by.
 * For a working directory, the first rule that applies wins:
 *
 *   1. link         a directory linked in projects.json (`dosu project link`), longest match
 *   2. env          the DOSU_PROJECT override
 *   3. origin       the git `origin` remote, normalized (`github.com/acme/widget`)
 *   4. root-commit  `git:<sha>` of the history's root commit, for clones with no origin
 *   5. path         `path:<git toplevel, or the directory itself>`
 *
 * Keys are opaque strings to the server; ingest, prompt-time push, and MCP must all send the
 * same one for the same checkout, so every caller resolves through here, and a session's key is
 * cached for it the first time it is resolved (sessions/project-dir.ts). */

import { createHash } from "node:crypto";
import { readFileSync, realpathSync } from "node:fs";
import { basename, join } from "node:path";
import { getConfigDir } from "../config/config";
import { displayRepo, originRepoOfDir, rootCommitOfDir, toplevelOfDir } from "./repo";

const LINKS_FILENAME = "projects.json";

/** The longest key the server accepts. */
export const MAX_PROJECT_KEY_LENGTH = 512;

type ProjectRule = "link" | "env" | "origin" | "root-commit" | "path";

export interface ProjectKey {
  project: string;
  /** Which rule produced the key, for `dosu project show` and the debug log. */
  rule: ProjectRule;
}

export interface ProjectLink {
  /** Absolute directory, without a trailing slash. */
  dir: string;
  project: string;
}

export interface ProjectOptions {
  /** Where projects.json lives; defaults to the CLI's config dir. */
  configDir?: string;
  /** Source of DOSU_PROJECT; defaults to process.env. */
  env?: NodeJS.ProcessEnv;
}

export function projectLinksPath(configDir: string = getConfigDir()): string {
  return join(configDir, LINKS_FILENAME);
}

/** A usable key: trimmed, non-empty, and within the server's limit; null otherwise. */
function validKey(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const key = value.trim();
  return key !== "" && key.length <= MAX_PROJECT_KEY_LENGTH ? key : null;
}

/** The directory links, skipping anything malformed; missing or corrupt file = no links. */
export function readProjectLinks(configDir: string = getConfigDir()): ProjectLink[] {
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(projectLinksPath(configDir), "utf-8"));
  } catch {
    return [];
  }
  const links = (raw as { links?: unknown } | null)?.links;
  if (!Array.isArray(links)) return [];
  const valid: ProjectLink[] = [];
  for (const link of links) {
    const { dir, project } = (link ?? {}) as { dir?: unknown; project?: unknown };
    const key = validKey(project);
    if (typeof dir !== "string" || !dir.startsWith("/") || key === null) continue;
    valid.push({ dir: dir.replace(/\/+$/, "") || "/", project: key });
  }
  return valid;
}

function realpathOr(path: string): string {
  try {
    return realpathSync(path);
  } catch {
    return path;
  }
}

/** Whether dir is at or under base (path-boundary aware). */
function isAtOrUnder(dir: string, base: string): boolean {
  return dir === base || dir.startsWith(base === "/" ? "/" : `${base}/`);
}

/** Rule 1: the link with the longest directory containing `dir`. Both sides are compared as
 * given and with symlinks resolved, so a link made through an alias still matches. */
function linkedProject(dir: string, links: readonly ProjectLink[]): string | null {
  const dirs = [...new Set([dir, realpathOr(dir)])];
  let best: ProjectLink | null = null;
  for (const link of links) {
    const bases = [...new Set([link.dir, realpathOr(link.dir)])];
    const contains = bases.some((base) => dirs.some((d) => isAtOrUnder(d, base)));
    if (contains && (best === null || link.dir.length > best.dir.length)) best = link;
  }
  return best?.project ?? null;
}

/** Rules 1 and 2, the user's explicit choices. `dir` may be null (only env can apply). `env`
 * must be the environment the session's agent ran in: DOSU_PROJECT means nothing for a session
 * some other process happens to be handling. */
export function projectOverride(
  dir: string | null,
  options: ProjectOptions = {},
): ProjectKey | null {
  if (dir !== null) {
    const linked = linkedProject(dir, readProjectLinks(options.configDir));
    if (linked !== null) return { project: linked, rule: "link" };
  }
  const env = validKey((options.env ?? process.env).DOSU_PROJECT);
  return env === null ? null : { project: env, rule: "env" };
}

/** Rules 3 to 5, what git says about `dir`. */
export function gitProjectOfDir(dir: string): ProjectKey {
  const origin = validKey(originRepoOfDir(dir));
  if (origin !== null) return { project: origin, rule: "origin" };
  const root = rootCommitOfDir(dir);
  if (root !== null) return { project: `git:${root}`, rule: "root-commit" };
  const path = `path:${realpathOr(toplevelOfDir(dir) ?? dir)}`;
  if (path.length <= MAX_PROJECT_KEY_LENGTH) return { project: path, rule: "path" };
  // Hashed rather than truncated, so two long paths never share a key.
  const digest = createHash("sha256").update(path.slice("path:".length)).digest("hex");
  return { project: `path:sha256:${digest}`, rule: "path" };
}

/** All five rules, uncached. */
export function resolveProjectOfDir(dir: string, options: ProjectOptions = {}): ProjectKey {
  return projectOverride(dir, options) ?? gitProjectOfDir(dir);
}

/** A project key short enough for a narrow column: `acme/widget` for an origin, `git:` and the
 * first 12 hex of a root commit, a path's last directory; a link or DOSU_PROJECT name as is. */
export function displayProjectKey(key: string): string {
  if (key.startsWith("git:")) return key.slice(0, "git:".length + 12);
  if (key.startsWith("path:sha256:")) return key.slice(0, "path:sha256:".length + 12);
  if (key.startsWith("path:")) return basename(key.slice("path:".length)) || key;
  // An origin: host (with a dot), owner, repo.
  if (/^[^/\s]+\.[^/\s]+\/[^/]+\/./.test(key)) return displayRepo(key);
  return key;
}
