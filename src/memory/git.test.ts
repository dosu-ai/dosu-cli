import { execFileSync } from "node:child_process";
import {
  cpSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { diffSnapshot, headCommit, SNAPSHOT_MAX_BYTES } from "./git";

/** The frozen memwriter's capture (coding-memory-bench 0951e6a `CAPTURE_COMMAND`), diff part. */
const FROZEN_CAPTURE =
  "git add -N . && git diff --name-only -z HEAD | " +
  "while IFS= read -r -d '' f; do git diff HEAD -- \"$f\" | head -n 80; done";

let root: string;
let repo: string;

function git(dir: string, ...args: string[]): string {
  return execFileSync(
    "git",
    ["-c", "user.name=t", "-c", "user.email=t@example.com", "-c", "commit.gpgsign=false", ...args],
    { cwd: dir, encoding: "utf-8" },
  );
}

function write(path: string, text: string): void {
  mkdirSync(join(path, ".."), { recursive: true });
  writeFileSync(path, text);
}

const lines = (n: number, tag: string) =>
  `${Array.from({ length: n }, (_, i) => `${tag} line ${i}`).join("\n")}\n`;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "dosu-memory-git-"));
  repo = join(root, "repo");
  mkdirSync(repo);
  git(repo, "init", "-q");
  write(join(repo, ".gitignore"), "build/\n");
  write(join(repo, "b.txt"), lines(120, "old"));
  write(join(repo, "src/m.py"), "x = 1\n");
  git(repo, "add", ".");
  git(repo, "commit", "-qm", "base");
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

describe("diffSnapshot", () => {
  it("matches the frozen capture: new files interleaved in byte order, 80 lines per file", () => {
    write(join(repo, "b.txt"), lines(120, "new"));
    write(join(repo, "a.txt"), lines(100, "added"));
    write(join(repo, "Z.txt"), "upper\n");
    write(join(repo, "src/n.py"), "y = 2\n");
    write(join(repo, "build/out.txt"), "ignored\n");
    const frozen = join(root, "frozen");
    cpSync(repo, frozen, { recursive: true });
    const expected = execFileSync("bash", ["-c", FROZEN_CAPTURE], {
      cwd: frozen,
      encoding: "utf-8",
    });

    const snapshot = diffSnapshot(join(repo, "src"), headCommit(repo));

    expect(snapshot).toBe(expected.trim());
    expect([...(snapshot ?? "").matchAll(/^diff --git a\/(\S+) b\//gm)].map((m) => m[1])).toEqual([
      "Z.txt",
      "a.txt",
      "b.txt",
      "src/n.py",
    ]);
    const added = (snapshot ?? "").split(/^(?=diff --git )/m).find((s) => s.includes(" b/a.txt"));
    expect(added?.trimEnd().split("\n")).toHaveLength(80);
  });

  it("never touches the user's index", () => {
    write(join(repo, "src/m.py"), "x = 3\n");
    write(join(repo, "new.txt"), "fresh\n");
    const index = join(repo, ".git", "index");
    const before = { bytes: readFileSync(index), mtime: statSync(index).mtimeMs };

    expect(diffSnapshot(repo, headCommit(repo))).toContain("diff --git a/new.txt b/new.txt");

    expect(readFileSync(index).equals(before.bytes)).toBe(true);
    expect(statSync(index).mtimeMs).toBe(before.mtime);
    expect(git(repo, "status", "--porcelain")).toBe(" M src/m.py\n?? new.txt\n");
  });

  it("past 64KB keeps every file's header but drops its lines", () => {
    for (let i = 0; i < 20; i++) {
      write(
        join(repo, `gen/f${String(i).padStart(2, "0")}.txt`),
        `${"z".repeat(100)}\n`.repeat(80),
      );
    }
    const snapshot = diffSnapshot(repo, headCommit(repo)) ?? "";

    const headers = [...snapshot.matchAll(/^diff --git a\/(\S+) b\//gm)].map((m) => m[1]);
    expect(headers).toHaveLength(20);
    expect(Buffer.byteLength(snapshot)).toBeLessThanOrEqual(SNAPSHOT_MAX_BYTES + 20 * 60);
    expect(snapshot.endsWith("diff --git a/gen/f19.txt b/gen/f19.txt")).toBe(true);
    expect(snapshot).toContain("diff --git a/gen/f00.txt b/gen/f00.txt\nnew file mode");
  });

  it("diffs against the session's starting commit, so commits made since still show", () => {
    const start = headCommit(repo);
    write(join(repo, "src/m.py"), "x = 4\n");
    git(repo, "commit", "-qam", "during the session");

    expect(headCommit(repo)).not.toBe(start);
    expect(diffSnapshot(repo, start)).toContain("+x = 4");
    expect(diffSnapshot(repo, headCommit(repo))).toBe("");
    expect(diffSnapshot(root, null)).toBeNull();
  });
});
