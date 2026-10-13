/** Editing projects.json, the directory links that project key rule 1 reads (project.ts). Edits
 * keep whatever else the file holds -- other keys, entries this version cannot read -- and never
 * overwrite a file that does not parse. */

import { existsSync, readFileSync } from "node:fs";
import { writeSecureFile } from "../mcp/config-helpers";
import { projectLinksPath, realpathOr } from "./project";

export class ProjectLinksError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ProjectLinksError";
  }
}

type LinksFile = Record<string, unknown> & { links: unknown[] };

function readLinksFile(configDir?: string): LinksFile {
  const path = projectLinksPath(configDir);
  if (!existsSync(path)) return { links: [] };
  const raw = readFileSync(path, "utf-8").trim();
  if (!raw) return { links: [] };
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new ProjectLinksError(`${path} is not valid JSON; fix or remove it, then retry.`);
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new ProjectLinksError(`${path} is not a JSON object; fix or remove it, then retry.`);
  }
  const file = parsed as Record<string, unknown>;
  return { ...file, links: Array.isArray(file.links) ? file.links : [] };
}

function writeLinksFile(file: LinksFile, configDir?: string): void {
  writeSecureFile(projectLinksPath(configDir), `${JSON.stringify(file, null, 2)}\n`);
}

/** Whether a stored entry links exactly `dir` (as given or through a symlink). */
function linksDir(entry: unknown, dir: string): boolean {
  const linked = (entry as { dir?: unknown } | null)?.dir;
  if (typeof linked !== "string") return false;
  const stored = linked.replace(/\/+$/, "") || "/";
  return stored === dir || realpathOr(stored) === realpathOr(dir);
}

/** Links absolute `dir` to `project` (already validated), replacing its previous link. */
export function linkProjectDir(dir: string, project: string, configDir?: string): void {
  const file = readLinksFile(configDir);
  file.links = [...file.links.filter((entry) => !linksDir(entry, dir)), { dir, project }];
  writeLinksFile(file, configDir);
}

/** Removes absolute `dir`'s own link; false when it had none. */
export function unlinkProjectDir(dir: string, configDir?: string): boolean {
  const file = readLinksFile(configDir);
  const kept = file.links.filter((entry) => !linksDir(entry, dir));
  if (kept.length === file.links.length) return false;
  file.links = kept;
  writeLinksFile(file, configDir);
  return true;
}
