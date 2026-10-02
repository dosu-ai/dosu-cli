import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  gitProjectOfDir,
  MAX_PROJECT_KEY_LENGTH,
  projectLinksPath,
  projectOverride,
  readProjectLinks,
  resolveProjectOfDir,
} from "./project";

let root: string;
let configDir: string;

beforeEach(() => {
  root = realpathSync(mkdtempSync(join(tmpdir(), "dosu-project-test-")));
  configDir = join(root, "config");
  mkdirSync(configDir);
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

function git(dir: string, ...args: string[]): string {
  return execFileSync(
    "git",
    [
      "-C",
      dir,
      "-c",
      "user.name=t",
      "-c",
      "user.email=t@t",
      "-c",
      "init.defaultBranch=main",
      ...args,
    ],
    { encoding: "utf-8", stdio: ["ignore", "pipe", "ignore"] },
  ).trim();
}

function repo(name: string, commits = 1): string {
  const dir = join(root, name);
  mkdirSync(dir, { recursive: true });
  git(dir, "init", "-q");
  for (let i = 0; i < commits; i++) git(dir, "commit", "-q", "--allow-empty", "-m", `c${i}`);
  return dir;
}

function writeLinks(links: unknown): void {
  writeFileSync(projectLinksPath(configDir), JSON.stringify({ links }));
}

const noEnv = {};

describe("resolveProjectOfDir", () => {
  it("rule 1: the longest linked directory containing the working directory wins", () => {
    const dir = repo("widget");
    git(dir, "remote", "add", "origin", "git@github.com:acme/widget.git");
    mkdirSync(join(dir, "pkg", "core"), { recursive: true });
    writeLinks([
      { dir: root, project: "acme-monorepo" },
      { dir: join(dir, "pkg"), project: "acme-pkg" },
    ]);

    const options = { configDir, env: { DOSU_PROJECT: "from-env" } };
    expect(resolveProjectOfDir(join(dir, "pkg", "core"), options)).toEqual({
      project: "acme-pkg",
      rule: "link",
    });
    expect(resolveProjectOfDir(dir, options)).toEqual({ project: "acme-monorepo", rule: "link" });
  });

  it("rule 1 respects path boundaries: /work/app2 is not under a link for /work/app", () => {
    const app2 = repo("app2");
    writeLinks([{ dir: join(root, "app"), project: "app" }]);

    expect(resolveProjectOfDir(app2, { configDir, env: noEnv }).rule).not.toBe("link");
  });

  it("rule 1 matches a link written through a symlinked path", () => {
    const real = repo("real");
    const alias = join(root, "alias");
    symlinkSync(real, alias);
    writeLinks([{ dir: alias, project: "aliased" }]);

    expect(resolveProjectOfDir(real, { configDir, env: noEnv })).toEqual({
      project: "aliased",
      rule: "link",
    });
  });

  it("rule 2: DOSU_PROJECT, trimmed, overrides git", () => {
    const dir = repo("widget");
    git(dir, "remote", "add", "origin", "https://github.com/Acme/Widget.git");

    expect(
      resolveProjectOfDir(dir, { configDir, env: { DOSU_PROJECT: "  poc-widget \n" } }),
    ).toEqual({ project: "poc-widget", rule: "env" });
    expect(resolveProjectOfDir(dir, { configDir, env: { DOSU_PROJECT: "   " } }).rule).toBe(
      "origin",
    );
  });

  it("rule 3: the normalized origin remote", () => {
    const dir = repo("widget");
    git(dir, "remote", "add", "origin", "https://github.com/Acme/Widget.git");
    mkdirSync(join(dir, "src"));

    expect(resolveProjectOfDir(join(dir, "src"), { configDir, env: noEnv })).toEqual({
      project: "github.com/acme/widget",
      rule: "origin",
    });
  });

  it("rule 4: a clone without an origin is keyed by its root commit", () => {
    const dir = repo("widget", 3);
    const rootCommit = git(dir, "rev-list", "--max-parents=0", "HEAD");

    expect(resolveProjectOfDir(dir, { configDir, env: noEnv })).toEqual({
      project: `git:${rootCommit}`,
      rule: "root-commit",
    });
  });

  it("rule 4 picks the lexicographically first of several root commits", () => {
    const dir = repo("widget");
    git(dir, "checkout", "-q", "--orphan", "other");
    git(dir, "commit", "-q", "--allow-empty", "-m", "other root");
    git(dir, "checkout", "-q", "main");
    git(dir, "merge", "-q", "--allow-unrelated-histories", "-m", "join", "other");
    const roots = git(dir, "rev-list", "--max-parents=0", "HEAD").split("\n").sort();

    expect(roots).toHaveLength(2);
    expect(resolveProjectOfDir(dir, { configDir, env: noEnv }).project).toBe(`git:${roots[0]}`);
  });

  it("rule 4 is skipped in a shallow clone: its parentless commit is the cut, not the root", () => {
    const upstream = repo("upstream", 3);
    const clone = join(root, "clone");
    execFileSync("git", ["clone", "-q", "--depth", "1", `file://${upstream}`, clone], {
      stdio: "ignore",
    });
    git(clone, "remote", "remove", "origin");

    expect(resolveProjectOfDir(clone, { configDir, env: noEnv })).toEqual({
      project: `path:${clone}`,
      rule: "path",
    });
  });

  it("rule 5: the git toplevel, or the directory itself outside a repo", () => {
    const empty = join(root, "fresh");
    mkdirSync(join(empty, "sub"), { recursive: true });
    git(empty, "init", "-q");
    const plain = join(root, "plain");
    mkdirSync(plain);

    // A repo with no commits has no root commit yet.
    expect(resolveProjectOfDir(join(empty, "sub"), { configDir, env: noEnv })).toEqual({
      project: `path:${empty}`,
      rule: "path",
    });
    expect(resolveProjectOfDir(plain, { configDir, env: noEnv })).toEqual({
      project: `path:${plain}`,
      rule: "path",
    });
  });

  it("rule 5 resolves symlinks and keeps a deleted directory's path as given", () => {
    const real = join(root, "real");
    mkdirSync(real);
    symlinkSync(real, join(root, "alias"));

    expect(resolveProjectOfDir(join(root, "alias"), { configDir, env: noEnv }).project).toBe(
      `path:${real}`,
    );
    expect(resolveProjectOfDir(join(root, "gone"), { configDir, env: noEnv }).project).toBe(
      `path:${join(root, "gone")}`,
    );
  });

  it("keeps every key within the server's limit", () => {
    const long = join(root, "x".repeat(200), "y".repeat(200), "z".repeat(200));
    mkdirSync(long, { recursive: true });
    writeLinks([{ dir: long, project: "p".repeat(MAX_PROJECT_KEY_LENGTH + 1) }]);

    const resolved = resolveProjectOfDir(long, {
      configDir,
      env: { DOSU_PROJECT: "e".repeat(MAX_PROJECT_KEY_LENGTH + 1) },
    });

    // Oversized link and env values are ignored; an oversized path is hashed, never truncated.
    expect(resolved.rule).toBe("path");
    expect(resolved.project).toMatch(/^path:sha256:[0-9a-f]{64}$/);
  });
});

describe("projectOverride", () => {
  it("applies only the explicit rules, and needs no directory for the env rule", () => {
    writeLinks([{ dir: "/work/app", project: "app" }]);

    expect(projectOverride("/work/app/src", { configDir, env: noEnv })).toEqual({
      project: "app",
      rule: "link",
    });
    expect(projectOverride(null, { configDir, env: { DOSU_PROJECT: "x" } })).toEqual({
      project: "x",
      rule: "env",
    });
    expect(projectOverride("/elsewhere", { configDir, env: noEnv })).toBeNull();
  });
});

describe("gitProjectOfDir", () => {
  it("ignores links and the env override", () => {
    const dir = repo("widget");
    git(dir, "remote", "add", "origin", "git@github.com:acme/widget.git");
    writeLinks([{ dir, project: "linked" }]);

    expect(gitProjectOfDir(dir)).toEqual({ project: "github.com/acme/widget", rule: "origin" });
  });
});

describe("readProjectLinks", () => {
  it("is empty when the file is missing or corrupt", () => {
    expect(readProjectLinks(configDir)).toEqual([]);
    writeFileSync(projectLinksPath(configDir), "{nope");
    expect(readProjectLinks(configDir)).toEqual([]);
  });

  it("drops malformed entries, relative dirs, and blank or oversized projects", () => {
    writeLinks([
      { dir: "/work/app/", project: " app " },
      { dir: "relative/dir", project: "rel" },
      { dir: "/work/blank", project: "  " },
      { dir: "/work/huge", project: "h".repeat(MAX_PROJECT_KEY_LENGTH + 1) },
      { dir: 42, project: "n" },
      "junk",
    ]);

    expect(readProjectLinks(configDir)).toEqual([{ dir: "/work/app", project: "app" }]);
  });
});
