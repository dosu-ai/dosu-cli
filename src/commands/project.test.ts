/** `dosu project link|unlink|show`, against a temporary home with real git checkouts. The links
 * they write are the ones every project key lookup reads (sessions/project.ts). */

import { execFileSync } from "node:child_process";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { projectLinksPath, resolveProjectOfDir } from "../sessions/project";
import { projectCommand } from "./project";

let home: string;
let origCwd: string;
let out: string[];
let err: string[];

beforeEach(() => {
  home = realpathSync(mkdtempSync(join(tmpdir(), "dosu-project-cmd-")));
  origCwd = process.cwd();
  vi.stubEnv("HOME", home);
  vi.stubEnv("XDG_CONFIG_HOME", join(home, ".config"));
  vi.stubEnv("DOSU_DEV", undefined);
  vi.stubEnv("DOSU_PROJECT", undefined);
  out = [];
  err = [];
  vi.spyOn(console, "log").mockImplementation((...args: unknown[]) => {
    out.push(args.join(" "));
  });
  vi.spyOn(console, "error").mockImplementation((...args: unknown[]) => {
    err.push(args.join(" "));
  });
});

afterEach(() => {
  process.chdir(origCwd);
  process.exitCode = undefined;
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  rmSync(home, { recursive: true, force: true });
});

async function dosu(...args: string[]): Promise<void> {
  const cmd = projectCommand();
  cmd.exitOverride();
  await cmd.parseAsync(["node", "dosu", ...args]);
}

function links(): unknown {
  return JSON.parse(readFileSync(projectLinksPath(), "utf-8"));
}

function dir(...parts: string[]): string {
  const path = join(home, ...parts);
  mkdirSync(path, { recursive: true });
  return path;
}

/** A clone with no origin remote: its key is `git:<root commit>`. */
function clone(name: string): { dir: string; root: string } {
  const path = dir("work", name);
  const git = (...args: string[]) =>
    execFileSync("git", ["-C", path, "-c", "user.name=t", "-c", "user.email=t@t", ...args], {
      encoding: "utf-8",
    });
  git("init", "-q");
  git("commit", "-q", "--allow-empty", "-m", "root");
  return { dir: path, root: git("rev-list", "--max-parents=0", "HEAD").trim() };
}

describe("dosu project link", () => {
  it("links a directory to a key that every lookup under it then resolves to", async () => {
    const repo = clone("widget");

    await dosu("link", repo.dir, "  acme/widget-poc ");

    expect(links()).toEqual({ links: [{ dir: repo.dir, project: "acme/widget-poc" }] });
    expect(resolveProjectOfDir(join(repo.dir, "src"))).toEqual({
      project: "acme/widget-poc",
      rule: "link",
    });
    expect(out.join("\n")).toContain(`Linked ${repo.dir} to project acme/widget-poc`);
  });

  it("links the current directory when given only a key", async () => {
    const work = dir("work", "app");
    process.chdir(work);

    await dosu("link", "app-key");

    expect(links()).toEqual({ links: [{ dir: work, project: "app-key" }] });
  });

  it("resolves a relative directory and drops a trailing slash", async () => {
    dir("work", "app");
    process.chdir(home);

    await dosu("link", "work/app/", "k");

    expect(links()).toEqual({ links: [{ dir: join(home, "work", "app"), project: "k" }] });
  });

  it("replaces the directory's previous key and keeps other links", async () => {
    const a = dir("a");
    const b = dir("b");
    await dosu("link", a, "one");
    await dosu("link", b, "two");
    await dosu("link", a, "three");

    expect(links()).toEqual({
      links: [
        { dir: b, project: "two" },
        { dir: a, project: "three" },
      ],
    });
  });

  it("treats a symlinked path to a linked directory as the same directory", async () => {
    const real = dir("real");
    symlinkSync(real, join(home, "alias"));
    await dosu("link", real, "one");
    await dosu("link", join(home, "alias"), "two");

    expect(links()).toEqual({ links: [{ dir: join(home, "alias"), project: "two" }] });
  });

  it("keeps fields and entries of projects.json it does not understand", async () => {
    mkdirSync(join(home, ".config", "dosu-cli"), { recursive: true });
    writeFileSync(
      projectLinksPath(),
      JSON.stringify({ note: "kept", links: [{ dir: "relative", project: "x" }] }),
    );
    const a = dir("a");

    await dosu("link", a, "one");

    expect(links()).toEqual({
      note: "kept",
      links: [
        { dir: "relative", project: "x" },
        { dir: a, project: "one" },
      ],
    });
  });

  it.each([
    ["an empty key", "   "],
    ["a key over 512 characters", "k".repeat(513)],
  ])("refuses %s", async (_label, key) => {
    const a = dir("a");
    await dosu("link", a, key);

    expect(process.exitCode).toBe(1);
    expect(err.join("\n")).toMatch(/key/i);
  });

  it("refuses a directory that does not exist", async () => {
    await dosu("link", join(home, "missing"), "k");

    expect(process.exitCode).toBe(1);
    expect(err.join("\n")).toContain("not a directory");
  });

  it.each([
    ["is not JSON", "{oops"],
    ["is not an object", "[]"],
  ])("refuses to overwrite a projects.json that %s", async (_label, content) => {
    mkdirSync(join(home, ".config", "dosu-cli"), { recursive: true });
    writeFileSync(projectLinksPath(), content);

    await dosu("link", dir("a"), "k");

    expect(process.exitCode).toBe(1);
    expect(err.join("\n")).toContain("projects.json");
    expect(readFileSync(projectLinksPath(), "utf-8")).toBe(content);
  });

  it("starts over from an empty projects.json", async () => {
    mkdirSync(join(home, ".config", "dosu-cli"), { recursive: true });
    writeFileSync(projectLinksPath(), "\n");
    const a = dir("a");

    await dosu("link", a, "k");

    expect(links()).toEqual({ links: [{ dir: a, project: "k" }] });
  });
});

describe("dosu project unlink", () => {
  it("refuses to rewrite a projects.json it cannot parse", async () => {
    mkdirSync(join(home, ".config", "dosu-cli"), { recursive: true });
    writeFileSync(projectLinksPath(), "{oops");

    await dosu("unlink", dir("a"));

    expect(process.exitCode).toBe(1);
    expect(readFileSync(projectLinksPath(), "utf-8")).toBe("{oops");
  });

  it("removes the directory's link, and lookups fall back to git", async () => {
    const repo = clone("widget");
    await dosu("link", repo.dir, "k");

    await dosu("unlink", repo.dir);

    expect(links()).toEqual({ links: [] });
    expect(resolveProjectOfDir(repo.dir)?.project).toBe(`git:${repo.root}`);
    expect(out.join("\n")).toContain(`Unlinked ${repo.dir}`);
  });

  it("unlinks the current directory by default", async () => {
    const a = dir("a");
    await dosu("link", a, "k");
    process.chdir(a);

    await dosu("unlink");

    expect(links()).toEqual({ links: [] });
  });

  it("says which link still applies to a directory that has none of its own", async () => {
    const parent = dir("mono");
    const child = dir("mono", "pkg");
    await dosu("link", parent, "mono-key");

    await dosu("unlink", child);

    expect(links()).toEqual({ links: [{ dir: parent, project: "mono-key" }] });
    expect(out.join("\n")).toContain(`No project link for ${child}`);
    expect(out.join("\n")).toContain(`linked at ${parent}`);
    expect(process.exitCode ?? 0).toBe(0);
  });
});

describe("dosu project show", () => {
  it("shows a link's key, the rule, and the linked directory", async () => {
    const parent = dir("mono");
    await dosu("link", parent, "mono-key");

    await dosu("show", dir("mono", "pkg"));

    const text = out.join("\n");
    expect(text).toContain("mono-key");
    expect(text).toContain("link");
    expect(text).toContain(parent);
  });

  it("shows the root-commit key of a clone with no origin", async () => {
    const repo = clone("widget");
    process.chdir(repo.dir);

    await dosu("show", "--json");

    expect(JSON.parse(out.join("\n"))).toEqual({
      dir: repo.dir,
      project: `git:${repo.root}`,
      rule: "root-commit",
    });
  });

  it("shows DOSU_PROJECT as the env rule", async () => {
    vi.stubEnv("DOSU_PROJECT", "from-env");

    await dosu("show", dir("anywhere"), "--json");

    expect(JSON.parse(out.join("\n"))).toMatchObject({ project: "from-env", rule: "env" });
  });

  it("shows an origin's normalized key", async () => {
    const repo = clone("widget");
    execFileSync("git", [
      "-C",
      repo.dir,
      "remote",
      "add",
      "origin",
      "git@github.com:Acme/Widget.git",
    ]);

    await dosu("show", repo.dir);

    expect(out.join("\n")).toContain("github.com/acme/widget");
    expect(out.join("\n")).toContain("origin");
  });

  it("shows the path key of a directory outside any repository", async () => {
    const plain = dir("plain");

    await dosu("show", plain, "--json");

    expect(JSON.parse(out.join("\n"))).toEqual({
      dir: plain,
      project: `path:${plain}`,
      rule: "path",
    });
  });
});
