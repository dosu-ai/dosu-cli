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

  it("wraps the repo cursor with up/down keys", () => {
    const prompt = makePrompt();
    expect(prompt.repoCursor).toBe(0);
    prompt.handleRawKeypress(undefined, { name: "up" });
    expect(prompt.repoCursor).toBe(prompt.repositories.length - 1);
    prompt.handleRawKeypress(undefined, { name: "down" });
    expect(prompt.repoCursor).toBe(0);
  });

  it("space toggles the current repo: deselects when all are selected, selects all otherwise", () => {
    const prompt = makePrompt();
    expect(prompt.getRepositorySelectionState(prompt.repositories[0])).toBe("all");
    prompt.handleRawKeypress(undefined, { name: "space" });
    expect(prompt.getRepositorySelectionState(prompt.repositories[0])).toBe("none");
    prompt.handleRawKeypress(undefined, { name: "space" });
    expect(prompt.getRepositorySelectionState(prompt.repositories[0])).toBe("all");
  });

  it("cancels with escape in repo mode and with ctrl+c", () => {
    const prompt = makePrompt();
    prompt.handleRawKeypress(undefined, { name: "escape" });
    expect(prompt.state).toBe("cancel");

    const prompt2 = makePrompt();
    prompt2.handleRawKeypress(undefined, { ctrl: true, name: "c" });
    expect(prompt2.state).toBe("cancel");
  });

  it("does nothing for unrecognized repo-mode keys", () => {
    const prompt = makePrompt();
    const before = prompt.repoCursor;
    prompt.handleRawKeypress(undefined, { name: "tab" });
    expect(prompt.repoCursor).toBe(before);
    expect(prompt.state).toBe("initial");
  });

  it("ignores left key in repo mode", () => {
    const prompt = makePrompt();
    expect(prompt.mode).toBe("repos");
    prompt.handleRawKeypress(undefined, { name: "left" });
    expect(prompt.mode).toBe("repos");
  });

  it("moves file cursor up and down inside file mode", () => {
    const prompt = makePrompt();
    prompt.handleRawKeypress(undefined, { name: "right" });
    expect(prompt.fileCursor).toBe(0);
    prompt.handleRawKeypress(undefined, { name: "down" });
    expect(prompt.fileCursor).toBe(1);
    prompt.handleRawKeypress(undefined, { name: "up" });
    expect(prompt.fileCursor).toBe(0);
    prompt.handleRawKeypress(undefined, { name: "up" });
    // wraps to last filtered file
    expect(prompt.fileCursor).toBe(1);
  });

  it("backspace removes search characters and clears searchActive when query empties", () => {
    const prompt = makePrompt();
    prompt.handleRawKeypress(undefined, { name: "right" });
    // 'a' is intercepted as "toggle all" before search is active, so start
    // typing with a different printable key.
    prompt.handleRawKeypress("d", undefined);
    prompt.handleRawKeypress("o", undefined);
    expect(prompt.searchQuery).toBe("do");
    expect(prompt.searchActive).toBe(true);
    prompt.handleRawKeypress(undefined, { name: "backspace" });
    expect(prompt.searchQuery).toBe("d");
    expect(prompt.searchActive).toBe(true);
    prompt.handleRawKeypress(undefined, { name: "backspace" });
    expect(prompt.searchQuery).toBe("");
    expect(prompt.searchActive).toBe(false);
  });

  it("escape in file mode without an active search cancels the prompt", () => {
    const prompt = makePrompt();
    prompt.handleRawKeypress(undefined, { name: "right" });
    prompt.handleRawKeypress(undefined, { name: "escape" });
    expect(prompt.state).toBe("cancel");
  });

  it("ignores synced files when toggling with space", () => {
    const prompt = new GitHubDocsImportPrompt({
      repositories: [
        {
          slug: "acme/core",
          files: [
            { id: "f-1", path: "README.md", is_synced: true },
            { id: "f-2", path: "docs/intro.md", is_synced: false },
          ],
        },
      ],
    });
    prompt.handleRawKeypress(undefined, { name: "right" });
    expect(prompt.fileCursor).toBe(0);
    expect(prompt.value).toEqual(["f-2"]);
    prompt.handleRawKeypress(undefined, { name: "space" });
    // synced file shouldn't toggle anything
    expect(prompt.value).toEqual(["f-2"]);
  });

  it("activates and types into search via printable keys", () => {
    const prompt = makePrompt();
    prompt.handleRawKeypress(undefined, { name: "right" });
    prompt.handleRawKeypress("d", undefined);
    expect(prompt.searchActive).toBe(true);
    expect(prompt.searchQuery).toBe("d");
  });

  it("does not change state for non-printable keys outside the switch", () => {
    const prompt = makePrompt();
    prompt.handleRawKeypress(undefined, { name: "right" });
    const before = prompt.searchQuery;
    prompt.handleRawKeypress(undefined, undefined);
    expect(prompt.searchQuery).toBe(before);
  });

  it("renders the 'Skip for now' submit label when no docs are selected", () => {
    const prompt = makePrompt();
    // Deselect every default-selected doc by toggling each repo off.
    prompt.handleRawKeypress(undefined, { name: "space" });
    prompt.handleRawKeypress(undefined, { name: "down" });
    prompt.handleRawKeypress(undefined, { name: "space" });
    expect(prompt.value).toEqual([]);
    (prompt as unknown as { state: string }).state = "submit";
    const submitOutput = (prompt as unknown as { renderPrompt: () => string }).renderPrompt();
    expect(submitOutput).toContain("Skip for now");
  });

  it("renders the cancel header without the option list", () => {
    const prompt = makePrompt();
    (prompt as unknown as { state: string }).state = "cancel";
    const cancelOutput = (prompt as unknown as { renderPrompt: () => string }).renderPrompt();
    expect(cancelOutput).toContain("Select docs to import");
    expect(cancelOutput).not.toContain("docs/auth/login.md");
  });

  it("renders an empty-state message in file mode when search has no matches", () => {
    const prompt = makePrompt();
    prompt.handleRawKeypress(undefined, { name: "right" });
    prompt.handleRawKeypress("z", undefined);
    prompt.handleRawKeypress("z", undefined);
    prompt.handleRawKeypress("z", undefined);
    const rendered = (prompt as unknown as { renderPrompt: () => string }).renderPrompt();
    expect(rendered).toContain("No docs match your search.");
  });

  it("submit label is singular for exactly one selected doc", () => {
    const prompt = new GitHubDocsImportPrompt({
      repositories: [
        {
          slug: "acme/api",
          files: [{ id: "only", path: "README.md", is_synced: false }],
        },
      ],
    });
    (prompt as unknown as { state: string }).state = "submit";
    const rendered = (prompt as unknown as { renderPrompt: () => string }).renderPrompt();
    expect(rendered).toContain("1 doc selected");
  });

  it("does not move the file cursor when no files match the search", () => {
    const prompt = makePrompt();
    prompt.handleRawKeypress(undefined, { name: "right" });
    prompt.handleRawKeypress("z", undefined);
    prompt.handleRawKeypress("z", undefined);
    expect(prompt.filteredFiles).toEqual([]);
    const before = prompt.fileCursor;
    prompt.handleRawKeypress(undefined, { name: "down" });
    expect(prompt.fileCursor).toBe(before);
  });

  it("locked repos render with a hint and selection state stays locked", () => {
    const prompt = new GitHubDocsImportPrompt({
      repositories: [
        {
          slug: "acme/locked",
          files: [{ id: "f-1", path: "README.md", is_synced: true }],
        },
      ],
    });
    expect(prompt.getRepositorySelectionState(prompt.repositories[0])).toBe("locked");
    const rendered = (prompt as unknown as { renderPrompt: () => string }).renderPrompt();
    expect(rendered).toContain("All docs already imported");
  });
});
