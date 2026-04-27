import { describe, expect, it } from "vitest";
import { GitHubDocsImportPrompt } from "./github-doc-import-prompt";

function makePrompt() {
  return new GitHubDocsImportPrompt({
    repositories: [
      {
        slug: "acme/api",
        files: [
          { id: "f-1", path: "docs/auth/login.md", is_synced: false },
          { id: "f-2", path: "docs/setup/github.md", is_synced: false },
        ],
      },
      {
        slug: "acme/core",
        files: [
          { id: "f-3", path: "README.md", is_synced: true },
          { id: "f-4", path: "docs/core/overview.md", is_synced: false },
        ],
      },
    ],
  });
}

describe("GitHubDocsImportPrompt", () => {
  it("defaults to selecting every importable doc and tracks partial repo state", () => {
    const prompt = makePrompt();

    expect(prompt.getRepositorySelectionState(prompt.repositories[0])).toBe("all");

    prompt.handleRawKeypress(undefined, { name: "right" });
    prompt.handleRawKeypress(undefined, { name: "space" });
    prompt.handleRawKeypress(undefined, { name: "left" });

    expect(prompt.mode).toBe("repos");
    expect(prompt.getRepositorySelectionState(prompt.repositories[0])).toBe("partial");
  });

  it("returns to the repo list when Enter is pressed inside a repo file list", () => {
    const prompt = makePrompt();

    prompt.handleRawKeypress(undefined, { name: "right" });
    prompt.handleRawKeypress(undefined, { name: "return" });

    expect(prompt.mode).toBe("repos");
    expect(prompt.state).toBe("initial");
  });

  it("filters files while searching and lets a toggle all visible results", () => {
    const prompt = makePrompt();

    prompt.handleRawKeypress(undefined, { name: "right" });
    prompt.handleRawKeypress("/", undefined);
    prompt.handleRawKeypress("a", undefined);
    prompt.handleRawKeypress("u", undefined);
    prompt.handleRawKeypress("t", undefined);
    prompt.handleRawKeypress("h", undefined);

    expect(prompt.searchQuery).toBe("auth");
    expect(prompt.filteredFiles.map((file) => file.path)).toEqual(["docs/auth/login.md"]);

    prompt.handleRawKeypress(undefined, { name: "escape" });
    expect(prompt.searchQuery).toBe("");

    prompt.handleRawKeypress("a", undefined);
    expect(prompt.value).toEqual(["f-4"]);
  });

  it("marks a repo as locked when every file is already imported", () => {
    const prompt = new GitHubDocsImportPrompt({
      repositories: [
        {
          slug: "acme/core",
          files: [{ id: "f-1", path: "README.md", is_synced: true }],
        },
      ],
    });

    expect(prompt.getRepositorySelectionState(prompt.repositories[0])).toBe("locked");
    prompt.handleRawKeypress(undefined, { name: "space" });
    expect(prompt.value).toEqual([]);
  });

  it("submits every importable doc by default when the user presses Enter immediately", () => {
    const prompt = makePrompt();

    prompt.handleRawKeypress(undefined, { name: "return" });

    expect(prompt.state).toBe("submit");
    expect(prompt.value).toEqual(["f-1", "f-2", "f-4"]);
  });

  it("limits the visible file list to 15 items while keeping all matches addressable", () => {
    const prompt = new GitHubDocsImportPrompt({
      repositories: [
        {
          slug: "acme/api",
          files: Array.from({ length: 20 }, (_, index) => ({
            id: `f-${index + 1}`,
            path: `docs/topic-${index + 1}.md`,
            is_synced: false,
          })),
        },
      ],
    });

    prompt.handleRawKeypress(undefined, { name: "right" });
    const rendered = (prompt as unknown as { renderPrompt: () => string }).renderPrompt();
    const visibleDocLines = rendered
      .split("\n")
      .filter((line) => line.includes("docs/topic-") || line.includes("..."));

    expect(visibleDocLines.length).toBeLessThanOrEqual(15);

    for (let i = 0; i < 18; i += 1) {
      prompt.handleRawKeypress(undefined, { name: "down" });
    }

    expect(prompt.fileCursor).toBe(18);
  });
});
