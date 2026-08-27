import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { assertSafeProjectPath, requireProjectRoot, resolveProjectRoot } from "./project-root";

const tempDirs: string[] = [];

function tempDir(): string {
  const path = mkdtempSync(join(tmpdir(), "dosu-project-root-"));
  tempDirs.push(path);
  return path;
}

afterEach(() => {
  for (const path of tempDirs.splice(0)) rmSync(path, { recursive: true, force: true });
});

describe("resolveProjectRoot", () => {
  it("returns the Git root when called from a nested directory", () => {
    const root = tempDir();
    execFileSync("git", ["init", "--quiet", root]);
    const nested = join(root, "packages", "cli");
    mkdirSync(nested, { recursive: true });

    expect(resolveProjectRoot(nested)).toBe(realpathSync(root));
  });

  it("returns null outside a Git work tree", () => {
    expect(resolveProjectRoot(tempDir())).toBeNull();
  });
});

describe("requireProjectRoot", () => {
  it("fails before setup can write outside a project", () => {
    expect(() => requireProjectRoot(tempDir())).toThrow("inside a Git project");
  });
});

describe("assertSafeProjectPath", () => {
  it("allows a new nested path under the verified root", () => {
    const root = realpathSync(tempDir());

    expect(() => assertSafeProjectPath(root, join(root, ".cursor", "mcp.json"))).not.toThrow();
  });

  it("allows existing regular directories and files", () => {
    const root = realpathSync(tempDir());
    const target = join(root, ".cursor", "mcp.json");
    mkdirSync(join(root, ".cursor"));
    writeFileSync(target, "{}\n");

    expect(() => assertSafeProjectPath(root, target)).not.toThrow();
  });

  it.each([
    ["the root itself", (root: string) => root],
    ["a parent escape", (root: string) => join(root, "..", "outside.json")],
    ["a sibling with the same prefix", (root: string) => `${root}-outside/mcp.json`],
  ])("rejects %s", (_name, targetForRoot) => {
    const root = realpathSync(tempDir());

    expect(() => assertSafeProjectPath(root, targetForRoot(root))).toThrow(
      "outside the verified Git project",
    );
  });

  it("rejects an existing symlink directory even when it points inside the root", () => {
    const root = realpathSync(tempDir());
    const realDirectory = join(root, "real-config");
    mkdirSync(realDirectory);
    symlinkSync(realDirectory, join(root, ".cursor"));

    expect(() => assertSafeProjectPath(root, join(root, ".cursor", "mcp.json"))).toThrow(
      "symbolic link",
    );
  });

  it("rejects a symlink directory that escapes the root", () => {
    const root = realpathSync(tempDir());
    const outside = tempDir();
    symlinkSync(outside, join(root, ".cursor"));

    expect(() => assertSafeProjectPath(root, join(root, ".cursor", "mcp.json"))).toThrow(
      "symbolic link",
    );
  });

  it("rejects the target file itself when it is a symlink", () => {
    const root = realpathSync(tempDir());
    const outside = join(tempDir(), "outside.json");
    writeFileSync(outside, "do not touch\n");
    symlinkSync(outside, join(root, ".mcp.json"));

    expect(() => assertSafeProjectPath(root, join(root, ".mcp.json"))).toThrow("symbolic link");
  });
});
