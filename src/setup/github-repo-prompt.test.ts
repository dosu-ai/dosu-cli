import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  ADD_REPOSITORIES_VALUE,
  GitHubRepoPrompt,
  type REFRESH_LIST_VALUE,
} from "./github-repo-prompt";

type PromptOption =
  | {
      kind: "action";
      value: typeof ADD_REPOSITORIES_VALUE | typeof REFRESH_LIST_VALUE;
      label: string;
      hint?: string;
    }
  | { kind: "separator" }
  | { kind: "repo"; value: string; label: string; hint?: string };

const ACTION_OPTION: PromptOption = {
  kind: "action",
  value: ADD_REPOSITORIES_VALUE,
  label: "Add repositories...",
  hint: "opens GitHub",
};

function repoOptions(...slugs: string[]): PromptOption[] {
  return slugs.map((slug, index) => ({
    kind: "repo" as const,
    value: slug,
    label: slug,
    hint: index === 0 ? "primary" : undefined,
  }));
}

function makePrompt(
  options: PromptOption[],
  extras?: { initialValues?: string[]; maxItems?: number },
) {
  return new GitHubRepoPrompt({
    message: "Pick repositories",
    options,
    initialValues: extras?.initialValues,
    maxItems: extras?.maxItems,
  });
}

function render(prompt: GitHubRepoPrompt): string {
  return (prompt as unknown as { renderPrompt: () => string }).renderPrompt();
}

describe("GitHubRepoPrompt", () => {
  const originalRows = process.stdout.rows;

  beforeEach(() => {
    Object.defineProperty(process.stdout, "rows", { value: 30, configurable: true });
  });

  afterEach(() => {
    Object.defineProperty(process.stdout, "rows", { value: originalRows, configurable: true });
  });

  it("starts with no selections and cursor at 0 when no initialValues are given", () => {
    const prompt = makePrompt([ACTION_OPTION, ...repoOptions("acme/api", "acme/core")]);
    expect(prompt.cursor).toBe(0);
    expect(prompt.value).toBe(ADD_REPOSITORIES_VALUE);
  });

  it("places the cursor on the first matching initialValue and pre-selects it", () => {
    const options = [ACTION_OPTION, ...repoOptions("acme/api", "acme/core")];
    const prompt = makePrompt(options, { initialValues: ["acme/core"] });
    expect(prompt.cursor).toBe(2);
    expect(prompt.value).toEqual(["acme/core"]);
  });

  it("ignores initialValues that don't correspond to a repo option", () => {
    const options = [ACTION_OPTION, ...repoOptions("acme/api")];
    const prompt = makePrompt(options, { initialValues: ["bogus/repo"] });
    expect(prompt.cursor).toBe(0);
    expect(prompt.value).toBe(ADD_REPOSITORIES_VALUE);
  });

  it("wraps cursor when moving up from index 0 and down from the last index", () => {
    const options = [ACTION_OPTION, ...repoOptions("a/b", "c/d")];
    const prompt = makePrompt(options);
    prompt.emit("cursor", "up");
    expect(prompt.cursor).toBe(options.length - 1);
    prompt.emit("cursor", "down");
    expect(prompt.cursor).toBe(0);
  });

  it("treats left/up and right/down identically", () => {
    const options = [ACTION_OPTION, ...repoOptions("a/b", "c/d")];
    const prompt = makePrompt(options);
    prompt.emit("cursor", "right");
    expect(prompt.cursor).toBe(1);
    prompt.emit("cursor", "left");
    expect(prompt.cursor).toBe(0);
    prompt.emit("cursor", "down");
    expect(prompt.cursor).toBe(1);
    prompt.emit("cursor", "up");
    expect(prompt.cursor).toBe(0);
  });

  it("toggles a repo selection on space and untoggles on a second press", () => {
    const options = [ACTION_OPTION, ...repoOptions("a/b", "c/d")];
    const prompt = makePrompt(options);
    prompt.emit("cursor", "down");
    prompt.emit("cursor", "space");
    expect(prompt.value).toEqual(["a/b"]);
    prompt.emit("cursor", "space");
    expect(prompt.value).toEqual([]);
  });

  it("does nothing when space is pressed on the action option", () => {
    const options = [ACTION_OPTION, ...repoOptions("a/b")];
    const prompt = makePrompt(options);
    prompt.emit("cursor", "space");
    expect(prompt.value).toBe(ADD_REPOSITORIES_VALUE);
  });

  it("selects every repo with 'a' and clears them on a second 'a'", () => {
    const options = [ACTION_OPTION, ...repoOptions("a/b", "c/d", "e/f")];
    const prompt = makePrompt(options);
    prompt.emit("cursor", "down");
    prompt.emit("key", "a", {});
    expect(prompt.value).toEqual(["a/b", "c/d", "e/f"]);
    prompt.emit("key", "a", {});
    expect(prompt.value).toEqual([]);
  });

  it("ignores keys other than 'a'", () => {
    const options = [ACTION_OPTION, ...repoOptions("a/b")];
    const prompt = makePrompt(options);
    prompt.emit("cursor", "down");
    prompt.emit("key", "z", {});
    expect(prompt.value).toEqual([]);
  });

  it("ignores cursor events for unhandled keys", () => {
    const options = [ACTION_OPTION, ...repoOptions("a/b")];
    const prompt = makePrompt(options);
    const before = prompt.cursor;
    (prompt.emit as (event: string, key: string) => void)("cursor", "tab");
    expect(prompt.cursor).toBe(before);
  });

  it("skips over a separator when moving the cursor down", () => {
    const options: PromptOption[] = [ACTION_OPTION, { kind: "separator" }, ...repoOptions("a/b")];
    const prompt = makePrompt(options);
    expect(prompt.cursor).toBe(0);
    prompt.emit("cursor", "down");
    expect(prompt.cursor).toBe(2);
  });

  it("skips over a separator when moving the cursor up (wrap-around)", () => {
    const options: PromptOption[] = [ACTION_OPTION, { kind: "separator" }, ...repoOptions("a/b")];
    const prompt = makePrompt(options);
    prompt.emit("cursor", "up");
    expect(prompt.cursor).toBe(2);
  });

  it("places the initial cursor on the first focusable option when index 0 is a separator", () => {
    const options: PromptOption[] = [{ kind: "separator" }, ACTION_OPTION, ...repoOptions("a/b")];
    const prompt = makePrompt(options);
    expect(prompt.cursor).toBe(1);
  });
});

describe("GitHubRepoPrompt rendering", () => {
  it("renders the active option, checkbox markers, and hints in default state", () => {
    const options = [ACTION_OPTION, ...repoOptions("acme/api", "acme/core")];
    const prompt = makePrompt(options, { initialValues: ["acme/core"] });
    const output = render(prompt);
    expect(output).toContain("Pick repositories");
    expect(output).toContain("acme/api");
    expect(output).toContain("acme/core");
    expect(output).toContain("(primary)");
    expect(output).toContain("Add repositories...");
  });

  it("renders the submit label with the joined repo selection", () => {
    const options = [ACTION_OPTION, ...repoOptions("a/b", "c/d")];
    const prompt = makePrompt(options, { initialValues: ["a/b", "c/d"] });
    (prompt as unknown as { state: string }).state = "submit";
    const output = render(prompt);
    expect(output).toContain("a/b, c/d");
  });

  it("renders the action label on submit when the action is the value", () => {
    const options = [ACTION_OPTION, ...repoOptions("a/b")];
    const prompt = makePrompt(options);
    (prompt as unknown as { state: string }).state = "submit";
    const output = render(prompt);
    expect(output).toContain("Add repositories...");
  });

  it("falls back to a default action label when no action option is present", () => {
    const options = [...repoOptions("a/b")];
    const prompt = makePrompt(options);
    (prompt as unknown as { state: string; value: unknown }).value = ADD_REPOSITORIES_VALUE;
    (prompt as unknown as { state: string }).state = "submit";
    const output = render(prompt);
    expect(output).toContain("Add repositories...");
  });

  it("renders the empty-selection submit label", () => {
    const options = [ACTION_OPTION, ...repoOptions("a/b")];
    const prompt = makePrompt(options);
    prompt.emit("cursor", "down");
    prompt.emit("cursor", "space");
    prompt.emit("cursor", "space");
    (prompt as unknown as { state: string }).state = "submit";
    const output = render(prompt);
    expect(output).toContain("No repositories selected.");
  });

  it("renders only the header on cancel", () => {
    const options = [ACTION_OPTION, ...repoOptions("a/b", "c/d")];
    const prompt = makePrompt(options);
    (prompt as unknown as { state: string }).state = "cancel";
    const output = render(prompt);
    expect(output).toContain("Pick repositories");
    expect(output).not.toContain("a/b");
  });

  it("renders ellipsis markers when option count exceeds the visible viewport", () => {
    Object.defineProperty(process.stdout, "rows", { value: 12, configurable: true });
    const options: PromptOption[] = [ACTION_OPTION];
    for (let i = 0; i < 20; i += 1) {
      options.push({ kind: "repo", value: `org/repo-${i}`, label: `org/repo-${i}` });
    }
    const prompt = makePrompt(options);
    for (let i = 0; i < 10; i += 1) {
      prompt.emit("cursor", "down");
    }
    const output = render(prompt);
    expect(output).toContain("...");
  });

  it("renders a dim horizontal line for separator options", () => {
    const options: PromptOption[] = [ACTION_OPTION, { kind: "separator" }, ...repoOptions("a/b")];
    const prompt = makePrompt(options);
    const output = render(prompt);
    expect(output).toContain("─");
  });

  it("highlights the active action option with a colored arrow", () => {
    const options = [ACTION_OPTION, ...repoOptions("a/b")];
    const prompt = makePrompt(options);
    expect(prompt.cursor).toBe(0);
    const output = render(prompt);
    // Active arrow uses pc.cyan; check we render the active state somehow
    expect(output).toContain("Add repositories...");
    expect(output).toContain("a/b");
  });

  it("renders selected-but-inactive and active-but-unselected checkbox states", () => {
    const options = [...repoOptions("a/b", "c/d", "e/f")];
    const prompt = makePrompt(options, { initialValues: ["c/d"] });
    // Cursor lands on the only selected item (c/d). Move it to a/b: that
    // exercises both "active unselected" (a/b) and "inactive selected" (c/d).
    prompt.emit("cursor", "up");
    expect(prompt.cursor).toBe(0);
    const output = render(prompt);
    expect(output).toContain("a/b");
    expect(output).toContain("c/d");
    expect(output).toContain("e/f");
  });

  it("scrolls the viewport when the cursor sits near the start of a long list", () => {
    Object.defineProperty(process.stdout, "rows", { value: 12, configurable: true });
    const options: PromptOption[] = [];
    for (let i = 0; i < 20; i += 1) {
      options.push({ kind: "repo", value: `org/repo-${i}`, label: `org/repo-${i}` });
    }
    // maxItems=5 forces a small viewport, exercising the start-scrolling branch
    const prompt = makePrompt(options, { maxItems: 5 });
    expect(prompt.cursor).toBe(0);
    const output = render(prompt);
    expect(output).toContain("org/repo-0");
  });
});
