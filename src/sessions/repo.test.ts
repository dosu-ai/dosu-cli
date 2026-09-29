import { execFileSync } from "node:child_process";
import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { displayRepo, normalizeRepoRemote, originRepoOfDir } from "./repo";

describe("normalizeRepoRemote", () => {
  it.each([
    ["git@github.com:dosu-ai/dosu-cli.git", "github.com/dosu-ai/dosu-cli"],
    ["github.com:dosu-ai/dosu-cli", "github.com/dosu-ai/dosu-cli"],
    ["https://github.com/dosu-ai/dosu-cli.git\n", "github.com/dosu-ai/dosu-cli"],
    ["https://user:token@GitHub.com/Dosu-AI/Dosu-CLI/", "github.com/dosu-ai/dosu-cli"],
    ["https://GitLab.com/Group/Proj.git", "gitlab.com/Group/Proj"],
    ["ssh://git@gitlab.example.com:2222/group/sub/proj.git", "gitlab.example.com/group/sub/proj"],
  ])("%s → %s", (remote, key) => {
    expect(normalizeRepoRemote(remote)).toBe(key);
  });

  it.each([
    "",
    "   ",
    "/srv/git/proj.git",
    "../proj",
    "file:///srv/git/proj.git",
    "https://github.com/solo",
    "not a url",
  ])("rejects %j", (remote) => {
    expect(normalizeRepoRemote(remote)).toBeNull();
  });
});

describe("displayRepo", () => {
  it("drops the host", () => {
    expect(displayRepo("github.com/dosu-ai/dosu-cli")).toBe("dosu-ai/dosu-cli");
    expect(displayRepo("gitlab.com/group/sub/proj")).toBe("group/sub/proj");
    expect(displayRepo("weird")).toBe("weird");
  });
});

describe("originRepoOfDir", () => {
  let dir: string;
  const git = (...args: string[]) => execFileSync("git", ["-C", dir, ...args], { stdio: "ignore" });

  beforeEach(() => {
    dir = realpathSync(mkdtempSync(join(tmpdir(), "dosu-repo-test-")));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("reads the normalized origin of the repo containing the directory", () => {
    git("init", "-q");
    git("remote", "add", "origin", "git@github.com:dosu-ai/dosu-cli.git");
    expect(originRepoOfDir(dir)).toBe("github.com/dosu-ai/dosu-cli");
  });

  it("ignores a GIT_DIR inherited from a hook environment", () => {
    git("init", "-q");
    git("remote", "add", "origin", "https://github.com/dosu-ai/dosu-cli");
    const previous = process.env.GIT_DIR;
    process.env.GIT_DIR = "/nonexistent/.git";
    try {
      expect(originRepoOfDir(dir)).toBe("github.com/dosu-ai/dosu-cli");
    } finally {
      if (previous === undefined) delete process.env.GIT_DIR;
      else process.env.GIT_DIR = previous;
    }
  });

  it("is null for a missing directory and for a repo without an origin", () => {
    expect(originRepoOfDir(join(dir, "missing"))).toBeNull();
    git("init", "-q");
    expect(originRepoOfDir(dir)).toBeNull();
  });
});
