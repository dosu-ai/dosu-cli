import { execFileSync } from "node:child_process";
import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  currentBranchOfDir,
  displayRepo,
  githubSlugOfRepo,
  headReflogOfDir,
  normalizeRepoRemote,
  originRepoOfDir,
} from "./repo";

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

describe("githubSlugOfRepo", () => {
  /** What the shipper sees: an origin remote, normalized, then narrowed to a GitHub slug. */
  const slugOfRemote = (remote: string) => githubSlugOfRepo(normalizeRepoRemote(remote));

  it.each([
    ["git@github.com:dosu-ai/dosu-cli.git", "dosu-ai/dosu-cli"],
    ["git@github.com:dosu-ai/dosu-cli", "dosu-ai/dosu-cli"],
    ["https://github.com/dosu-ai/dosu-cli.git", "dosu-ai/dosu-cli"],
    ["https://github.com/dosu-ai/dosu-cli", "dosu-ai/dosu-cli"],
    ["https://github.com/dosu-ai/dosu-cli/\n", "dosu-ai/dosu-cli"],
    ["ssh://git@github.com/dosu-ai/dosu-cli.git", "dosu-ai/dosu-cli"],
    ["ssh://git@github.com/dosu-ai/dosu-cli", "dosu-ai/dosu-cli"],
    ["ssh://git@github.com:22/dosu-ai/dosu-cli.git", "dosu-ai/dosu-cli"],
    ["https://GitHub.com/Dosu-AI/Dosu.CLI_2.git", "dosu-ai/dosu.cli_2"],
  ])("%j → %s", (remote, slug) => {
    expect(slugOfRemote(remote)).toBe(slug);
  });

  it.each([
    "https://x-access-token:ghp_abcdefghijklmnopqrstuvwxyz0123456789@github.com/acme/app.git",
    "https://alice:s3cret@github.com/acme/app",
    "https://ghp_abcdefghijklmnopqrstuvwxyz0123456789@github.com/acme/app.git",
    "ssh://alice:s3cret@github.com/acme/app.git",
  ])("keeps nothing of the credentials in %j", (remote) => {
    expect(slugOfRemote(remote)).toBe("acme/app");
  });

  it.each([
    "git@gitlab.com:acme/app.git",
    "https://gitlab.com/acme/app.git",
    "https://github.example.com/acme/app.git",
    "https://github.com.evil.test/acme/app.git",
    "git@bitbucket.org:acme/app.git",
    "https://github.com/acme",
    "https://github.com/acme/app/tree/main",
    "/srv/git/app.git",
    "file:///srv/git/app.git",
    "",
  ])("rejects %j", (remote) => {
    expect(slugOfRemote(remote)).toBeNull();
  });

  it("is null without a repo", () => {
    expect(githubSlugOfRepo(null)).toBeNull();
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

  it("reads the current branch and the HEAD reflog; a detached HEAD has no branch", () => {
    expect(currentBranchOfDir(dir)).toBeNull();
    expect(headReflogOfDir(dir)).toBeNull();
    git("init", "-q", "-b", "main");
    git("-c", "user.name=t", "-c", "user.email=t@t", "commit", "-q", "--allow-empty", "-m", "a");
    git("checkout", "-q", "-b", "feat/x");
    expect(currentBranchOfDir(dir)).toBe("feat/x");
    expect(headReflogOfDir(dir)).toMatch(
      /^HEAD@\{\d+\}\tcheckout: moving from main to feat\/x\nHEAD@\{\d+\}\tcommit \(initial\): a\n/,
    );
    git("checkout", "-q", "--detach");
    expect(currentBranchOfDir(dir)).toBeNull();
  });
});
