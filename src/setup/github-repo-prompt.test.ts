import { EventEmitter } from "node:events";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  ADD_REPOSITORIES_VALUE,
  GitHubRepoPrompt,
  KEYS_HINT,
  promptGitHubRepositories,
  type REFRESH_LIST_VALUE,
  validateRepoSelection,
} from "./github-repo-prompt";

const ESC = String.fromCharCode(27);
const UP = `${ESC}[A`;
const DOWN = `${ESC}[B`;
const LEFT = `${ESC}[D`;
const RIGHT = `${ESC}[C`;
const ENTER = "\r";
const SPACE = " ";
const CTRL_C = String.fromCharCode(3);

type PromptOption =
  | {
      kind: "action";
      value: typeof ADD_REPOSITORIES_VALUE | typeof REFRESH_LIST_VALUE;
      label: string;
      hint?: string;
    }
  | { kind: "separator" }
  | { kind: "repo"; value: string; label: string; hint?: string; disabled?: boolean };

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

function stripAnsi(text: string): string {
  return text.replace(new RegExp(`${ESC}\\[[0-9;?]*[A-Za-z]`, "g"), "");
}

function render(prompt: GitHubRepoPrompt): string {
  return stripAnsi(prompt.render().join("\n"));
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
    expect(prompt.selectedValues()).toEqual([]);
  });

  it("places the cursor on the first matching initialValue and pre-selects it", () => {
    const options = [ACTION_OPTION, ...repoOptions("acme/api", "acme/core")];
    const prompt = makePrompt(options, { initialValues: ["acme/core"] });
    expect(prompt.cursor).toBe(2);
    expect(prompt.selectedValues()).toEqual(["acme/core"]);
  });

  it("ignores initialValues that don't correspond to a repo option", () => {
    const options = [ACTION_OPTION, ...repoOptions("acme/api")];
    const prompt = makePrompt(options, { initialValues: ["bogus/repo"] });
    expect(prompt.cursor).toBe(0);
    expect(prompt.selectedValues()).toEqual([]);
  });

  it("wraps cursor when moving up from index 0 and down from the last index", () => {
    const options = [ACTION_OPTION, ...repoOptions("a/b", "c/d")];
    const prompt = makePrompt(options);
    prompt.handle(UP);
    expect(prompt.cursor).toBe(options.length - 1);
    prompt.handle(DOWN);
    expect(prompt.cursor).toBe(0);
  });

  it("treats left/up and right/down identically, plus vim keys", () => {
    const options = [ACTION_OPTION, ...repoOptions("a/b", "c/d")];
    const prompt = makePrompt(options);
    prompt.handle(RIGHT);
    expect(prompt.cursor).toBe(1);
    prompt.handle(LEFT);
    expect(prompt.cursor).toBe(0);
    prompt.handle("j");
    expect(prompt.cursor).toBe(1);
    prompt.handle("k");
    expect(prompt.cursor).toBe(0);
  });

  it("toggles a repo selection on space and untoggles on a second press", () => {
    const options = [ACTION_OPTION, ...repoOptions("a/b", "c/d")];
    const prompt = makePrompt(options);
    prompt.handle(DOWN);
    prompt.handle(SPACE);
    expect(prompt.selectedValues()).toEqual(["a/b"]);
    prompt.handle(SPACE);
    expect(prompt.selectedValues()).toEqual([]);
  });

  it("does nothing when space is pressed on the action option", () => {
    const options = [ACTION_OPTION, ...repoOptions("a/b")];
    const prompt = makePrompt(options);
    prompt.handle(SPACE);
    expect(prompt.selectedValues()).toEqual([]);
  });

  it("selects every repo with 'a' and clears them on a second 'a'", () => {
    const options = [ACTION_OPTION, ...repoOptions("a/b", "c/d", "e/f")];
    const prompt = makePrompt(options);
    prompt.handle("a");
    expect(prompt.selectedValues()).toEqual(["a/b", "c/d", "e/f"]);
    prompt.handle("a");
    expect(prompt.selectedValues()).toEqual([]);
  });

  it("ignores unhandled keys", () => {
    const options = [ACTION_OPTION, ...repoOptions("a/b")];
    const prompt = makePrompt(options);
    const before = prompt.cursor;
    expect(prompt.handle("z")).toEqual({ type: "none" });
    expect(prompt.cursor).toBe(before);
    expect(prompt.selectedValues()).toEqual([]);
  });

  it("skips over a separator when moving the cursor down", () => {
    const options: PromptOption[] = [ACTION_OPTION, { kind: "separator" }, ...repoOptions("a/b")];
    const prompt = makePrompt(options);
    expect(prompt.cursor).toBe(0);
    prompt.handle(DOWN);
    expect(prompt.cursor).toBe(2);
  });

  it("skips over a separator when moving the cursor up (wrap-around)", () => {
    const options: PromptOption[] = [ACTION_OPTION, { kind: "separator" }, ...repoOptions("a/b")];
    const prompt = makePrompt(options);
    prompt.handle(UP);
    expect(prompt.cursor).toBe(2);
  });

  it("places the initial cursor on the first focusable option when index 0 is a separator", () => {
    const options: PromptOption[] = [{ kind: "separator" }, ACTION_OPTION, ...repoOptions("a/b")];
    const prompt = makePrompt(options);
    expect(prompt.cursor).toBe(1);
  });

  it("skips over a disabled repo when moving the cursor", () => {
    const options: PromptOption[] = [
      ACTION_OPTION,
      { kind: "repo", value: "fork/one", label: "fork/one", disabled: true, hint: "Forked repo" },
      ...repoOptions("a/b"),
    ];
    const prompt = makePrompt(options);
    prompt.handle(DOWN);
    expect(prompt.cursor).toBe(2);
    prompt.handle(UP);
    expect(prompt.cursor).toBe(0);
  });

  it("excludes disabled repos from select-all", () => {
    const options: PromptOption[] = [
      ACTION_OPTION,
      { kind: "repo", value: "fork/one", label: "fork/one", disabled: true },
      ...repoOptions("a/b", "c/d"),
    ];
    const prompt = makePrompt(options);
    prompt.handle("a");
    expect(prompt.selectedValues()).toEqual(["a/b", "c/d"]);
    prompt.handle("a");
    expect(prompt.selectedValues()).toEqual([]);
  });

  it("ignores initialValues that point at a disabled repo", () => {
    const options: PromptOption[] = [
      ACTION_OPTION,
      { kind: "repo", value: "fork/one", label: "fork/one", disabled: true },
      ...repoOptions("a/b"),
    ];
    const prompt = makePrompt(options, { initialValues: ["fork/one"] });
    expect(prompt.cursor).toBe(0);
    expect(prompt.selectedValues()).toEqual([]);
  });

  it("does not toggle a disabled repo even if space fires while it is current", () => {
    // The cursor normally can't land on a disabled option; force it there to
    // cover the toggleCurrent guard directly.
    const options: PromptOption[] = [
      { kind: "repo", value: "fork/one", label: "fork/one", disabled: true },
      ...repoOptions("a/b"),
    ];
    const prompt = makePrompt(options);
    prompt.cursor = 0;
    prompt.handle(SPACE);
    expect(prompt.selectedValues()).toEqual([]);
  });
});

describe("GitHubRepoPrompt submit and cancel", () => {
  it("submits the action value with its label as the echo when the cursor is on an action", () => {
    const options = [ACTION_OPTION, ...repoOptions("a/b")];
    const prompt = makePrompt(options);
    const action = prompt.handle(ENTER);
    expect(action.type).toBe("done");
    if (action.type !== "done") return;
    expect(action.value).toBe(ADD_REPOSITORIES_VALUE);
    expect(stripAnsi(action.echo ?? "")).toContain("Add repositories...");
  });

  it("submits the selected repos in option order", () => {
    const options = [ACTION_OPTION, ...repoOptions("a/b", "c/d")];
    const prompt = makePrompt(options);
    // Select c/d first, then a/b — submission still lists a/b before c/d.
    prompt.handle(DOWN);
    prompt.handle(DOWN);
    prompt.handle(SPACE);
    prompt.handle(UP);
    prompt.handle(SPACE);
    const action = prompt.handle(ENTER);
    expect(action.type).toBe("done");
    if (action.type !== "done") return;
    expect(action.value).toEqual(["a/b", "c/d"]);
    expect(stripAnsi(action.echo ?? "")).toContain("a/b \u00B7 c/d");
  });

  it("counts the picks in the echo when more than three repos are selected", () => {
    const options = repoOptions("a/b", "c/d", "e/f", "g/h");
    const prompt = makePrompt(options);
    prompt.handle("a");
    const action = prompt.handle(ENTER);
    expect(action.type).toBe("done");
    if (action.type !== "done") return;
    expect(stripAnsi(action.echo ?? "")).toContain("4 selected");
  });

  it("re-renders with a validation hint instead of submitting an empty selection", () => {
    const options = [ACTION_OPTION, ...repoOptions("a/b")];
    const prompt = makePrompt(options);
    prompt.handle(DOWN);
    expect(prompt.handle(ENTER)).toEqual({ type: "render" });
    const output = render(prompt);
    expect(output).toContain("Select at least one repository");
    expect(output).not.toContain(KEYS_HINT);
    // The option list stays visible so the user can fix the selection in place.
    expect(output).toContain("a/b");
  });

  it("clears the validation hint on the next selection change", () => {
    const options = [ACTION_OPTION, ...repoOptions("a/b")];
    const prompt = makePrompt(options);
    prompt.handle(DOWN);
    prompt.handle(ENTER);
    prompt.handle(SPACE);
    expect(render(prompt)).toContain(KEYS_HINT);
  });

  it("cancels on ctrl-c, esc, and q", () => {
    for (const key of [CTRL_C, ESC, "q"]) {
      const prompt = makePrompt([ACTION_OPTION, ...repoOptions("a/b")]);
      expect(prompt.handle(key)).toEqual({ type: "cancel" });
    }
  });
});

describe("GitHubRepoPrompt rendering", () => {
  const originalRows = process.stdout.rows;

  beforeEach(() => {
    Object.defineProperty(process.stdout, "rows", { value: 30, configurable: true });
  });

  afterEach(() => {
    Object.defineProperty(process.stdout, "rows", { value: originalRows, configurable: true });
  });

  it("renders the message, options, checkbox markers, and hints", () => {
    const options = [ACTION_OPTION, ...repoOptions("acme/api", "acme/core")];
    const prompt = makePrompt(options, { initialValues: ["acme/core"] });
    const output = render(prompt);
    expect(output).toContain("Pick repositories");
    expect(output).toContain("acme/api");
    expect(output).toContain("\u25A0 acme/core");
    expect(output).toContain("(primary)");
    expect(output).toContain("\u2192 Add repositories...");
  });

  it("renders the key legend on the footer line in default state", () => {
    const options = [ACTION_OPTION, ...repoOptions("a/b")];
    const prompt = makePrompt(options);
    expect(render(prompt)).toContain(KEYS_HINT);
  });

  it("renders ellipsis markers when option count exceeds the visible viewport", () => {
    Object.defineProperty(process.stdout, "rows", { value: 12, configurable: true });
    const options: PromptOption[] = [ACTION_OPTION];
    for (let i = 0; i < 20; i += 1) {
      options.push({ kind: "repo", value: `org/repo-${i}`, label: `org/repo-${i}` });
    }
    const prompt = makePrompt(options);
    for (let i = 0; i < 10; i += 1) {
      prompt.handle(DOWN);
    }
    expect(render(prompt)).toContain("...");
  });

  it("renders a disabled repo dimmed with its hint", () => {
    const options: PromptOption[] = [
      ACTION_OPTION,
      {
        kind: "repo",
        value: "test-forker/driver",
        label: "test-forker/driver",
        disabled: true,
        hint: "Forked repo; connect node-escpos/driver instead",
      },
      ...repoOptions("a/b"),
    ];
    const output = render(makePrompt(options));
    expect(output).toContain("test-forker/driver");
    expect(output).toContain("Forked repo; connect node-escpos/driver instead");
  });

  it("renders a disabled repo without a hint", () => {
    const options: PromptOption[] = [
      ACTION_OPTION,
      { kind: "repo", value: "fork/one", label: "fork/one", disabled: true },
      ...repoOptions("a/b"),
    ];
    expect(render(makePrompt(options))).toContain("fork/one");
  });

  it("renders a dim horizontal line for separator options", () => {
    const options: PromptOption[] = [ACTION_OPTION, { kind: "separator" }, ...repoOptions("a/b")];
    expect(render(makePrompt(options))).toContain("\u2500");
  });

  it("marks the active row with the pointer", () => {
    const options = [ACTION_OPTION, ...repoOptions("a/b")];
    const prompt = makePrompt(options);
    prompt.handle(DOWN);
    const lines = prompt.render().map(stripAnsi);
    expect(lines.find((line) => line.includes("a/b"))).toContain("\u25B8");
    expect(lines.find((line) => line.includes("Add repositories"))).not.toContain("\u25B8");
  });

  it("renders selected-but-inactive and active-but-unselected checkbox states", () => {
    const options = [...repoOptions("a/b", "c/d", "e/f")];
    const prompt = makePrompt(options, { initialValues: ["c/d"] });
    // Cursor lands on the only selected item (c/d). Move it to a/b: that
    // exercises both "active unselected" (a/b) and "inactive selected" (c/d).
    prompt.handle(UP);
    expect(prompt.cursor).toBe(0);
    const output = render(prompt);
    expect(output).toContain("\u25A1 a/b");
    expect(output).toContain("\u25A0 c/d");
    expect(output).toContain("\u25A1 e/f");
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
    expect(render(prompt)).toContain("org/repo-0");
  });
});

describe("validateRepoSelection", () => {
  it("rejects an empty repo selection so Enter cannot submit nothing", () => {
    expect(validateRepoSelection([])).toContain("Select at least one repository");
  });

  it("accepts a non-empty selection", () => {
    expect(validateRepoSelection(["acme/api"])).toBeUndefined();
  });

  it("lets action options submit as usual", () => {
    expect(validateRepoSelection(ADD_REPOSITORIES_VALUE)).toBeUndefined();
    expect(validateRepoSelection(undefined)).toBeUndefined();
  });
});

describe("promptGitHubRepositories (frame runner wiring)", () => {
  function fakeIO(overrides: { inputTTY?: boolean } = {}) {
    const input = Object.assign(new EventEmitter(), {
      isTTY: overrides.inputTTY ?? true,
      isRaw: false,
      setRawMode(raw: boolean) {
        this.isRaw = raw;
      },
      resume() {},
      pause() {},
    }) as unknown as NodeJS.ReadStream;

    const written: string[] = [];
    const output = {
      isTTY: true,
      columns: 80,
      write(chunk: string) {
        written.push(chunk);
        return true;
      },
    } as unknown as NodeJS.WriteStream;

    return { input, output, text: () => stripAnsi(written.join("")) };
  }

  it("runs the full select-and-confirm flow over a TTY", async () => {
    const { input, output, text } = fakeIO();
    const result = promptGitHubRepositories(
      { message: "Pick repositories", options: [ACTION_OPTION, ...repoOptions("a/b")] },
      { input, output },
    );
    input.emit("data", DOWN);
    input.emit("data", SPACE);
    input.emit("data", ENTER);
    await expect(result).resolves.toEqual(["a/b"]);
    expect(text()).toContain("Pick repositories \u00B7 a/b");
  });

  it("resolves to the cancel symbol when stdin is not interactive", async () => {
    const { input, output } = fakeIO({ inputTTY: false });
    const result = await promptGitHubRepositories(
      { message: "Pick repositories", options: [ACTION_OPTION, ...repoOptions("a/b")] },
      { input, output },
    );
    expect(typeof result).toBe("symbol");
  });
});
