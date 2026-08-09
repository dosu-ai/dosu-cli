import { existsSync, lstatSync, realpathSync, statSync } from "node:fs";
import { isAbsolute, relative, resolve, sep } from "node:path";

function isInside(root: string, candidate: string): boolean {
  const rel = relative(root, candidate);
  return rel === "" || (!rel.startsWith(`..${sep}`) && rel !== ".." && !isAbsolute(rel));
}

function entryExists(path: string): boolean {
  try {
    lstatSync(path);
    return true;
  } catch (error: unknown) {
    if (typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT") {
      return false;
    }
    throw error;
  }
}

/** Refuse project writes that escape through `..` or an existing symlink component. */
export function assertSafeProjectPath(projectRoot: string, targetPath: string): void {
  const root = resolve(projectRoot);
  const target = resolve(targetPath);
  if (!isInside(root, target)) {
    throw new Error(`Project path escapes the repository: ${targetPath}`);
  }
  if (!existsSync(root) || !statSync(root).isDirectory()) {
    throw new Error(`Project root is not a directory: ${projectRoot}`);
  }

  const canonicalRoot = realpathSync(root);
  const rel = relative(root, target);
  let current = root;
  for (const segment of rel.split(sep).filter(Boolean)) {
    current = resolve(current, segment);
    if (!entryExists(current)) continue;
    if (lstatSync(current).isSymbolicLink()) {
      throw new Error(`Refusing to write through symbolic link at ${current}`);
    }
    if (!isInside(canonicalRoot, realpathSync(current))) {
      throw new Error(`Project path resolves outside the repository: ${current}`);
    }
  }
}
