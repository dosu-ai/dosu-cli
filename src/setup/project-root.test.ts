import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { requireProjectRoot, resolveProjectRoot } from "./project-root";

let tempDir: string;

beforeEach(() => {
  tempDir = realpathSync(mkdtempSync(join(tmpdir(), "dosu-project-root-")));
});

afterEach(() => {
  rmSync(tempDir, { recursive: true, force: true });
});

describe("resolveProjectRoot", () => {
  it("returns the worktree root when invoked from a nested directory", () => {
    execFileSync("git", ["init"], { cwd: tempDir, stdio: "ignore" });
    const nested = join(tempDir, "packages", "api");
    mkdirSync(nested, { recursive: true });

    expect(resolveProjectRoot(nested)).toBe(tempDir);
  });

  it("returns null outside a Git worktree", () => {
    expect(resolveProjectRoot(tempDir)).toBeNull();
  });

  it("returns null for a bare repository", () => {
    execFileSync("git", ["init", "--bare"], { cwd: tempDir, stdio: "ignore" });
    expect(resolveProjectRoot(tempDir)).toBeNull();
  });
});

describe("requireProjectRoot", () => {
  it("explains that project-scoped setup must run inside a Git worktree", () => {
    expect(() => requireProjectRoot(tempDir)).toThrow(/inside a Git worktree/i);
  });
});
