import { execFileSync } from "node:child_process";
import { realpathSync } from "node:fs";
import { isAbsolute, relative, resolve } from "node:path";

const projectProofBrand: unique symbol = Symbol("DosuProjectProof");

export interface ProjectProof {
  readonly root: string;
  readonly cwd: string;
  readonly [projectProofBrand]: true;
}

export type ProjectProofResult =
  | { ok: true; proof: ProjectProof }
  | {
      ok: false;
      reason:
        | "not_git_worktree"
        | "bare_repository"
        | "cwd_outside_project"
        | "invalid_git_root"
        | "git_probe_failed";
    };

export interface ProjectFacts {
  cwd: string;
  gitTopLevel: string;
  insideWorkTree: boolean;
  bareRepository: boolean;
}

function containsPath(root: string, candidate: string): boolean {
  const path = relative(root, candidate);
  return (
    path === "" ||
    (path !== ".." &&
      !path.startsWith(`..${process.platform === "win32" ? "\\" : "/"}`) &&
      !isAbsolute(path))
  );
}

export function proveProjectScope(facts: ProjectFacts): ProjectProofResult {
  if (!facts.insideWorkTree) return { ok: false, reason: "not_git_worktree" };
  if (facts.bareRepository) return { ok: false, reason: "bare_repository" };
  if (!isAbsolute(facts.gitTopLevel)) return { ok: false, reason: "invalid_git_root" };

  const cwd = resolve(facts.cwd);
  const root = resolve(facts.gitTopLevel);
  if (!containsPath(root, cwd)) return { ok: false, reason: "cwd_outside_project" };
  return { ok: true, proof: { root, cwd, [projectProofBrand]: true } };
}

function gitValue(cwd: string, args: string[]): string {
  return execFileSync("git", ["-C", cwd, ...args], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "ignore"],
  }).trim();
}

export function resolveProjectProof(cwd: string): ProjectProofResult {
  try {
    const realCwd = realpathSync(cwd);
    const insideWorkTree = gitValue(realCwd, ["rev-parse", "--is-inside-work-tree"]) === "true";
    const bareRepository = gitValue(realCwd, ["rev-parse", "--is-bare-repository"]) === "true";
    const gitTopLevel = realpathSync(gitValue(realCwd, ["rev-parse", "--show-toplevel"]));
    return proveProjectScope({ cwd: realCwd, gitTopLevel, insideWorkTree, bareRepository });
  } catch {
    return { ok: false, reason: "git_probe_failed" };
  }
}

export function assertProjectProof(proof: ProjectProof): void {
  if (proof?.[projectProofBrand] !== true) {
    throw new Error("A verified project proof is required for legacy migration");
  }
}
