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

  it("renders and closes via the readline hook when state finalizes", () => {
    const prompt = makePrompt();
    let renderCalls = 0;
    let closed = false;
    // Simulate an attached readline interface so handleRawKeypress exercises
    // the `rl`-guarded render + close paths.
    (prompt as unknown as { rl: unknown }).rl = { line: "", cursor: 0 };
    (prompt as unknown as { render: () => void }).render = () => {
      renderCalls += 1;
    };
    (prompt as unknown as { close: () => void }).close = () => {
      closed = true;
    };

    // A non-finalizing key triggers a render but no close.
    prompt.handleRawKeypress(undefined, { name: "down" });
    expect(renderCalls).toBe(1);
    expect(closed).toBe(false);

    // Enter in repo mode finalizes (state=submit) and closes.
    prompt.handleRawKeypress(undefined, { name: "return" });
    expect(prompt.state).toBe("submit");
    expect(renderCalls).toBe(2);
    expect(closed).toBe(true);
  });

  it("invokes the constructor render hook when the prompt renders through readline", () => {
    const prompt = makePrompt();
    (prompt as unknown as { rl: unknown }).rl = { line: "", cursor: 0 };
    // Capture stdout writes so the real @clack render does not leak escapes
    // into the test reporter, then drive a render through the rl hook.
    const original = process.stdout.write.bind(process.stdout);
    (process.stdout as unknown as { write: () => boolean }).write = () => true;
    try {
      prompt.handleRawKeypress(undefined, { name: "down" });
    } finally {
      (process.stdout as unknown as { write: typeof original }).write = original;
    }
    expect(prompt.fileCursor).toBe(0);
  });

  it("ignores non-printable multi-character keys in file mode", () => {
    const prompt = makePrompt();
    prompt.handleRawKeypress(undefined, { name: "right" });
    const before = prompt.searchQuery;
    // A multi-character key (e.g. a function key sequence) is not printable and
    // must not be appended to the search query.
    prompt.handleRawKeypress("[A", undefined);
    expect(prompt.searchQuery).toBe(before);
    expect(prompt.searchActive).toBe(false);
  });

  it("does nothing when moving the repo cursor with no repositories", () => {
    const prompt = new GitHubDocsImportPrompt({ repositories: [] });
    prompt.handleRawKeypress(undefined, { name: "down" });
    expect(prompt.repoCursor).toBe(0);
    expect(prompt.state).toBe("initial");
  });

  it("does not enter a repository when none exists", () => {
    const prompt = new GitHubDocsImportPrompt({ repositories: [] });
    prompt.handleRawKeypress(undefined, { name: "right" });
    expect(prompt.mode).toBe("repos");
  });

  it("does not toggle a repository when none exists", () => {
    const prompt = new GitHubDocsImportPrompt({ repositories: [] });
    prompt.handleRawKeypress(undefined, { name: "space" });
    expect(prompt.value).toEqual([]);
  });

  it("falls back to 'Files' title and empty file list when the repo cursor is out of range", () => {
    const prompt = makePrompt();
    prompt.handleRawKeypress(undefined, { name: "right" });
    // Force file mode with an out-of-range cursor so currentRepository is undefined.
    (prompt as unknown as { repoCursor: number }).repoCursor = 99;
    expect(prompt.filteredFiles).toEqual([]);
    const rendered = (prompt as unknown as { renderPrompt: () => string }).renderPrompt();
    expect(rendered).toContain("Files");
    expect(rendered).toContain("No docs match your search.");
  });

  it("selects an unselected file when toggled on", () => {
    const prompt = makePrompt();
    // Start with nothing selected so the first toggle is an "add".
    prompt.handleRawKeypress(undefined, { name: "space" });
    prompt.handleRawKeypress(undefined, { name: "down" });
    prompt.handleRawKeypress(undefined, { name: "space" });
    expect(prompt.value).toEqual([]);

    prompt.handleRawKeypress(undefined, { name: "up" });
    prompt.handleRawKeypress(undefined, { name: "right" });
    prompt.handleRawKeypress(undefined, { name: "space" });
    expect(prompt.value).toEqual(["f-1"]);
  });

  it("does not toggle-all when there are no selectable visible files", () => {
    const prompt = new GitHubDocsImportPrompt({
      repositories: [
        {
          slug: "acme/core",
          files: [{ id: "f-1", path: "README.md", is_synced: true }],
        },
      ],
    });
    prompt.handleRawKeypress(undefined, { name: "right" });
    prompt.handleRawKeypress("a", undefined);
    expect(prompt.value).toEqual([]);
  });

  it("toggle-all selects every visible file when not all are selected", () => {
    const prompt = makePrompt();
    prompt.handleRawKeypress(undefined, { name: "right" });
    // Deselect everything in this repo, then toggle-all to re-select.
    prompt.handleRawKeypress("a", undefined);
    expect(prompt.value).toEqual(["f-4"]);
    prompt.handleRawKeypress("a", undefined);
    expect(prompt.value?.toSorted()).toEqual(["f-1", "f-2", "f-4"]);
  });

  it("renders inactive repo rows with plain labels and no hint", () => {
    const prompt = makePrompt();
    const rendered = (prompt as unknown as { renderPrompt: () => string }).renderPrompt();
    // The second repo is inactive (cursor is on the first) and not locked, so
    // it renders a plain slug with no '(All docs already imported)' hint.
    const coreLine = rendered.split("\n").find((line) => line.includes("acme/core"));
    expect(coreLine).toBeDefined();
    expect(coreLine).not.toContain("All docs already imported");
  });

  it("renders a top ellipsis when scrolled past the start of a long repo list", () => {
    // Repo mode has no per-mode item cap, so the visible window is derived from
    // the terminal height; pin it small enough to force windowing + ellipsis.
    const original = process.stdout.rows;
    Object.defineProperty(process.stdout, "rows", { value: 18, configurable: true });
    try {
      const prompt = new GitHubDocsImportPrompt({
        repositories: Array.from({ length: 30 }, (_, index) => ({
          slug: `acme/repo-${index + 1}`,
          files: [{ id: `r${index + 1}-f1`, path: "docs/a.md", is_synced: false }],
        })),
      });
      for (let i = 0; i < 20; i += 1) {
        prompt.handleRawKeypress(undefined, { name: "down" });
      }
      const rendered = (prompt as unknown as { renderPrompt: () => string }).renderPrompt();
      expect(rendered).toContain("...");
    } finally {
      Object.defineProperty(process.stdout, "rows", { value: original, configurable: true });
    }
  });

  it("shows the 'type to filter' placeholder, then an empty active-search field", () => {
    const prompt = makePrompt();
    prompt.handleRawKeypress(undefined, { name: "right" });
    let rendered = (prompt as unknown as { renderPrompt: () => string }).renderPrompt();
    expect(rendered).toContain("type to filter");

    // Activating search with no query yet renders neither the placeholder nor a query.
    prompt.handleRawKeypress("/", undefined);
    rendered = (prompt as unknown as { renderPrompt: () => string }).renderPrompt();
    expect(rendered).not.toContain("type to filter");
    expect(prompt.searchActive).toBe(true);
    expect(prompt.searchQuery).toBe("");

    // Typing a query renders the query text.
    prompt.handleRawKeypress("d", undefined);
    rendered = (prompt as unknown as { renderPrompt: () => string }).renderPrompt();
    expect(rendered).toContain("Search: d");
  });

  it("renders synced rows (active and inactive) and selected rows in file mode", () => {
    const prompt = new GitHubDocsImportPrompt({
      repositories: [
        {
          slug: "acme/mixed",
          files: [
            { id: "f-1", path: "docs/synced-a.md", is_synced: true },
            { id: "f-2", path: "docs/synced-b.md", is_synced: true },
            { id: "f-3", path: "docs/selectable.md", is_synced: false },
          ],
        },
      ],
    });
    prompt.handleRawKeypress(undefined, { name: "right" });

    // Cursor on the first synced row: active synced marker + label.
    let rendered = (prompt as unknown as { renderPrompt: () => string }).renderPrompt();
    expect(rendered).toContain("docs/synced-a.md");
    expect(rendered).toContain("docs/synced-b.md");
    expect(rendered).toContain("(Already imported)");
    expect(rendered).toContain("docs/selectable.md");

    // Move cursor onto the selectable (selected) row: active selected marker.
    prompt.handleRawKeypress(undefined, { name: "down" });
    prompt.handleRawKeypress(undefined, { name: "down" });
    expect(prompt.fileCursor).toBe(2);
    rendered = (prompt as unknown as { renderPrompt: () => string }).renderPrompt();
    // Inactive synced rows and an inactive-vs-active selectable row are now rendered.
    expect(rendered).toContain("docs/synced-a.md");
    expect(rendered).toContain("docs/selectable.md");

    // Deselect the selectable row so the inactive/active unselected branches render.
    prompt.handleRawKeypress(undefined, { name: "space" });
    expect(prompt.value).toEqual([]);
    rendered = (prompt as unknown as { renderPrompt: () => string }).renderPrompt();
    expect(rendered).toContain("docs/selectable.md");

    // Move cursor off the selectable row so an inactive unselected row renders.
    prompt.handleRawKeypress(undefined, { name: "up" });
    rendered = (prompt as unknown as { renderPrompt: () => string }).renderPrompt();
    expect(rendered).toContain("docs/selectable.md");
  });

  it("renders all repository marker states for both active and inactive rows", () => {
    const prompt = new GitHubDocsImportPrompt({
      repositories: [
        {
          slug: "acme/all",
          files: [{ id: "a-1", path: "docs/a.md", is_synced: false }],
        },
        {
          slug: "acme/partial",
          files: [
            { id: "p-1", path: "docs/p1.md", is_synced: false },
            { id: "p-2", path: "docs/p2.md", is_synced: false },
          ],
        },
        {
          slug: "acme/none",
          files: [{ id: "n-1", path: "docs/n.md", is_synced: false }],
        },
        {
          slug: "acme/locked",
          files: [{ id: "l-1", path: "README.md", is_synced: true }],
        },
      ],
    });

    // Make the second repo partial and the third repo "none".
    prompt.handleRawKeypress(undefined, { name: "down" }); // -> acme/partial
    prompt.handleRawKeypress(undefined, { name: "right" });
    prompt.handleRawKeypress(undefined, { name: "space" }); // deselect first file -> partial
    prompt.handleRawKeypress(undefined, { name: "left" });
    expect(prompt.getRepositorySelectionState(prompt.repositories[1])).toBe("partial");

    prompt.handleRawKeypress(undefined, { name: "down" }); // -> acme/none
    prompt.handleRawKeypress(undefined, { name: "space" }); // deselect all -> none
    expect(prompt.getRepositorySelectionState(prompt.repositories[2])).toBe("none");

    // Render with cursor on the "none" repo: all/partial/locked rows are inactive,
    // and the active row is "none".
    let rendered = (prompt as unknown as { renderPrompt: () => string }).renderPrompt();
    expect(rendered).toContain("acme/all");
    expect(rendered).toContain("acme/partial");
    expect(rendered).toContain("acme/none");
    expect(rendered).toContain("All docs already imported");

    // Now move the cursor across each repo so the active branch of every
    // marker state is exercised.
    prompt.handleRawKeypress(undefined, { name: "up" }); // -> acme/partial (active partial)
    rendered = (prompt as unknown as { renderPrompt: () => string }).renderPrompt();
    expect(prompt.repoCursor).toBe(1);

    prompt.handleRawKeypress(undefined, { name: "up" }); // -> acme/all (active all)
    rendered = (prompt as unknown as { renderPrompt: () => string }).renderPrompt();
    expect(prompt.repoCursor).toBe(0);

    prompt.handleRawKeypress(undefined, { name: "up" }); // -> acme/locked (active locked)
    rendered = (prompt as unknown as { renderPrompt: () => string }).renderPrompt();
    expect(prompt.repoCursor).toBe(3);
    expect(rendered).toContain("All docs already imported");
  });

  it("renders a plural submit label when multiple docs are selected", () => {
    const prompt = makePrompt();
    (prompt as unknown as { state: string }).state = "submit";
    const rendered = (prompt as unknown as { renderPrompt: () => string }).renderPrompt();
    expect(rendered).toContain("3 docs selected");
  });

  it("derives the visible window from the terminal height when rows is set", () => {
    const original = process.stdout.rows;
    Object.defineProperty(process.stdout, "rows", { value: 30, configurable: true });
    try {
      const prompt = new GitHubDocsImportPrompt({
        repositories: [
          {
            slug: "acme/api",
            files: Array.from({ length: 40 }, (_, index) => ({
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
      // 30 rows - 8 = 22 visible window, capped at MAX_VISIBLE_FILE_ITEMS (15).
      expect(visibleDocLines.length).toBeLessThanOrEqual(15);
    } finally {
      Object.defineProperty(process.stdout, "rows", { value: original, configurable: true });
    }
  });

  it("scrolls the file window down so the lower bound branch is taken", () => {
    const prompt = new GitHubDocsImportPrompt({
      repositories: [
        {
          slug: "acme/api",
          files: Array.from({ length: 25 }, (_, index) => ({
            id: `f-${index + 1}`,
            path: `docs/topic-${index + 1}.md`,
            is_synced: false,
          })),
        },
      ],
    });
    prompt.handleRawKeypress(undefined, { name: "right" });
    for (let i = 0; i < 20; i += 1) {
      prompt.handleRawKeypress(undefined, { name: "down" });
    }
    expect(prompt.fileCursor).toBe(20);
    const rendered = (prompt as unknown as { renderPrompt: () => string }).renderPrompt();
    // Window has scrolled; the late topic is visible and a top ellipsis is shown.
    expect(rendered).toContain("docs/topic-21.md");
    expect(rendered).toContain("...");
  });

  it("keeps the window pinned to the top while the cursor sits in the middle band", () => {
    const prompt = new GitHubDocsImportPrompt({
      repositories: [
        {
          slug: "acme/api",
          files: Array.from({ length: 25 }, (_, index) => ({
            id: `f-${index + 1}`,
            path: `docs/topic-${index + 1}.md`,
            is_synced: false,
          })),
        },
      ],
    });
    prompt.handleRawKeypress(undefined, { name: "right" });
    // Cursor in the middle band (>= 2 and well below the lower-bound trigger):
    // neither windowing branch fires, so the window stays anchored at the top.
    for (let i = 0; i < 5; i += 1) {
      prompt.handleRawKeypress(undefined, { name: "down" });
    }
    expect(prompt.fileCursor).toBe(5);
    const rendered = (prompt as unknown as { renderPrompt: () => string }).renderPrompt();
    // Top item still visible (no top ellipsis), but a bottom ellipsis is present.
    expect(rendered).toContain("docs/topic-1.md");
    expect(rendered).toContain("...");
  });
});
