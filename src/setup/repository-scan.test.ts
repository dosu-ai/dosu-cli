import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { scanGitRepositories, validateScanDirectories } from "./repository-scan";

describe("repository scanning", () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = realpathSync(mkdtempSync(join(tmpdir(), "dosu-repo-scan-")));
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  function initRepository(path: string): void {
    mkdirSync(path, { recursive: true });
    execFileSync("git", ["init", "-q", path]);
    execFileSync("git", ["-C", path, "config", "user.name", "Dosu Test"]);
    execFileSync("git", ["-C", path, "config", "user.email", "dosu@example.test"]);
    writeFileSync(join(path, "README.md"), "test\n");
    execFileSync("git", ["-C", path, "add", "README.md"]);
    execFileSync("git", ["-C", path, "commit", "-qm", "initial"]);
  }

  it("finds a normal checkout and each linked worktree as separate projects", () => {
    const repository = join(tempDir, "projects", "main");
    const worktree = join(tempDir, "projects", "feature");
    initRepository(repository);
    execFileSync("git", ["-C", repository, "worktree", "add", "-qb", "feature", worktree]);

    expect(scanGitRepositories([join(tempDir, "projects")])).toEqual([
      { kind: "worktree", path: realpathSync(worktree) },
      { kind: "repository", path: realpathSync(repository) },
    ]);
  });

  it("does not follow directory symlinks while scanning", () => {
    const outside = join(tempDir, "outside", "repo");
    const scanRoot = join(tempDir, "scan");
    initRepository(outside);
    mkdirSync(scanRoot);
    symlinkSync(dirname(outside), join(scanRoot, "linked"));

    expect(scanGitRepositories([scanRoot])).toEqual([]);
  });

  it("deduplicates overlapping scan roots", () => {
    const repository = join(tempDir, "projects", "repo");
    initRepository(repository);

    expect(scanGitRepositories([join(tempDir, "projects"), repository])).toEqual([
      { kind: "repository", path: realpathSync(repository) },
    ]);
  });

  it("rejects Home, its ancestors, missing paths, and symlinked roots", () => {
    const fakeHome = join(tempDir, "home", "user");
    const safeRoot = join(fakeHome, "code");
    mkdirSync(safeRoot, { recursive: true });
    const linkedRoot = join(tempDir, "linked-code");
    symlinkSync(safeRoot, linkedRoot);

    expect(() => validateScanDirectories([fakeHome], fakeHome)).toThrow(/Home/i);
    expect(() => validateScanDirectories([dirname(fakeHome)], fakeHome)).toThrow(/Home/i);
    expect(() => validateScanDirectories([join(tempDir, "missing")], fakeHome)).toThrow(
      /directory/i,
    );
    expect(() => validateScanDirectories([linkedRoot], fakeHome)).toThrow(/symbolic link/i);
    expect(validateScanDirectories([safeRoot, safeRoot], fakeHome)).toEqual([
      realpathSync(safeRoot),
    ]);
  });
});
