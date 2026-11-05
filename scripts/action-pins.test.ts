import { readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

// Tags and branches are mutable: whoever controls an action's repository can move
// them to a malicious commit (as happened with tj-actions/changed-files), and that
// code then runs in CI with our secrets. Every action must be pinned to a full
// commit SHA, with the release it came from as a trailing comment so Dependabot
// can bump both.
const ROOT = fileURLToPath(new URL("..", import.meta.url));
const GITHUB_DIR = join(ROOT, ".github");

interface UsesLine {
  file: string;
  line: number;
  ref: string;
  text: string;
}

function isPinned(ref: string): boolean {
  if (ref.startsWith("./")) return true;
  if (ref.startsWith("docker://")) return /@sha256:[0-9a-f]{64}$/.test(ref);
  return /^[^@\s]+@[0-9a-f]{40}$/.test(ref);
}

// Line-based on purpose: it also sees commented-out steps, so re-enabling one
// can't bring back a mutable tag.
function findUses(file: string, content: string): UsesLine[] {
  return content.split("\n").flatMap((text, index) => {
    const match = /^\s*(?:#\s*)?(?:-\s+)?uses:\s*["']?([^\s"'#]+)/.exec(text);
    return match ? [{ file, line: index + 1, ref: match[1], text: text.trim() }] : [];
  });
}

const yamlFiles = (readdirSync(GITHUB_DIR, { recursive: true }) as string[])
  .filter((path) => /\.ya?ml$/.test(path))
  .map((path) => `.github/${path.split("\\").join("/")}`)
  .sort();
const compositeActions = yamlFiles.filter((path) => /(^|\/)action\.ya?ml$/.test(path));
const uses = yamlFiles.flatMap((file) => findUses(file, readFileSync(join(ROOT, file), "utf8")));

describe("GitHub Actions pins", () => {
  it("rejects mutable refs and accepts pinned ones", () => {
    for (const ref of [
      "actions/checkout@v4",
      "actions/checkout@v4.2.2",
      "actions/checkout@main",
      "actions/checkout@3d3c42e",
      "actions/checkout@3D3C42E5AAC5BA805825DA76410C181273BA90B1",
      "actions/checkout",
      "docker://alpine:3",
    ]) {
      expect(isPinned(ref), ref).toBe(false);
    }
    for (const ref of [
      "actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1",
      `actions/cache/restore@${"0".repeat(40)}`,
      "./.github/actions/setup",
      `docker://alpine@sha256:${"f".repeat(64)}`,
    ]) {
      expect(isPinned(ref), ref).toBe(true);
    }
  });

  it("reads step, job, quoted, and commented-out uses lines", () => {
    const fixture = [
      "jobs:",
      "  reuse:",
      "    uses: org/repo/.github/workflows/x.yml@main",
      "  build:",
      "    steps:",
      "      - uses: actions/checkout@v4",
      '      - uses: "oven-sh/setup-bun@v2"',
      "      # - uses: tj-actions/changed-files@v46",
      "      - name: Run",
      "        run: echo uses: not-an-action@v1",
    ].join("\n");
    expect(findUses("fixture.yml", fixture).map(({ ref }) => ref)).toEqual([
      "org/repo/.github/workflows/x.yml@main",
      "actions/checkout@v4",
      "oven-sh/setup-bun@v2",
      "tj-actions/changed-files@v46",
    ]);
  });

  it("finds the workflows", () => {
    expect(yamlFiles).toContain(".github/workflows/ci.yml");
    expect(uses.length).toBeGreaterThan(10);
  });

  it("pins every action to a full commit SHA", () => {
    const unpinned = uses
      .filter(({ ref }) => !isPinned(ref))
      .map(
        ({ file, line, ref }) =>
          `${file}:${line}: ${ref} is not pinned to a full 40-character commit SHA`,
      );
    expect(unpinned).toEqual([]);
  });

  it("names the release of every pinned action in a trailing comment", () => {
    const missing = uses
      .filter(({ ref, text }) => /@[0-9a-f]{40}$/.test(ref) && !/ # v\d\S*$/.test(text))
      .map(({ file, line, text }) => `${file}:${line}: ${text} needs a "# vX.Y.Z" comment`);
    expect(missing).toEqual([]);
  });

  it("keeps the pins updated with Dependabot, including composite actions", () => {
    const config = readFileSync(join(GITHUB_DIR, "dependabot.yml"), "utf8");
    expect(config).toMatch(/package-ecosystem:\s*["']?github-actions["']?/);
    // Dependabot scans only the workflows of "/" and the action.yml of each listed
    // directory, so every composite action needs its own entry.
    const missing = compositeActions
      .map((file) => `/${dirname(file)}`)
      .filter((dir) => !config.includes(`"${dir}"`));
    expect(
      missing,
      "add these to the github-actions directories in .github/dependabot.yml",
    ).toEqual([]);
  });
});
