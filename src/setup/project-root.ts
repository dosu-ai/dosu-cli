import { execFileSync } from "node:child_process";
import { lstatSync, realpathSync } from "node:fs";
import { isAbsolute, join, parse, relative, resolve, sep } from "node:path";

/** Resolve the repository root that project-scoped setup is allowed to modify. */
export function resolveProjectRoot(cwd: string = process.cwd()): string | null {
  try {
    const output = execFileSync("git", ["rev-parse", "--show-toplevel"], {
      cwd,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
    if (!output) return null;
    return realpathSync(isAbsolute(output) ? output : resolve(cwd, output));
  } catch {
    return null;
  }
}

export function requireProjectRoot(cwd: string = process.cwd()): string {
  const root = resolveProjectRoot(cwd);
  if (!root) {
    throw new Error("Run Dosu setup inside a Git project.");
  }
  return root;
}

/** True when an existing component of an absolute or relative path is a symbolic link. */
export function hasSymlinkInPath(targetPath: string): boolean {
  const target = resolve(targetPath);
  const root = parse(target).root;
  let current = root;

  for (const segment of relative(root, target).split(sep).filter(Boolean)) {
    current = join(current, segment);
    try {
      if (lstatSync(current).isSymbolicLink()) return true;
    } catch (err: unknown) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") return false;
      return true;
    }
  }
  return false;
}

/**
 * Refuse project mutations that escape the verified root or traverse a
 * pre-existing symbolic link. Call immediately before reading or writing a
 * project-owned path.
 */
export function assertSafeProjectPath(projectRoot: string, targetPath: string): void {
  const root = resolve(projectRoot);
  const target = resolve(targetPath);
  const targetRelative = relative(root, target);
  if (
    !targetRelative ||
    targetRelative === ".." ||
    targetRelative.startsWith(`..${sep}`) ||
    isAbsolute(targetRelative)
  ) {
    throw new Error(`Refusing to access a path outside the verified Git project: ${target}`);
  }

  let current = root;
  for (const segment of targetRelative.split(sep)) {
    current = join(current, segment);
    try {
      if (lstatSync(current).isSymbolicLink()) {
        throw new Error(`Refusing to access a symbolic link in the project path: ${current}`);
      }
    } catch (err: unknown) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") return;
      throw err;
    }
  }
}
