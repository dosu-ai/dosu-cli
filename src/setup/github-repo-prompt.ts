import { Prompt } from "@clack/core";
import pc from "picocolors";
import {
  ACTIVE_SYMBOL,
  BAR,
  CANCEL_SYMBOL,
  CHECKBOX_OFF,
  CHECKBOX_ON,
  ELLIPSIS,
  FOOTER,
  SUBMIT_SYMBOL,
  symbol,
} from "./prompt-symbols";

const ACTION_ARROW = symbol("→", ">");
const SEPARATOR_LINE = "─".repeat(30);

export const ADD_REPOSITORIES_VALUE = "__add_repositories__" as const;
export const REFRESH_LIST_VALUE = "__refresh_list__" as const;

type ActionValue = typeof ADD_REPOSITORIES_VALUE | typeof REFRESH_LIST_VALUE;

type PromptOption =
  | {
      kind: "action";
      value: ActionValue;
      label: string;
      hint?: string;
    }
  | {
      kind: "separator";
    }
  | {
      kind: "repo";
      value: string;
      label: string;
      hint?: string;
    };

interface PromptGitHubRepositoriesOptions {
  message: string;
  options: PromptOption[];
  initialValues?: string[];
  maxItems?: number;
}

/* v8 ignore start -- TTY-only wrapper; logic covered via GitHubRepoPrompt tests */
export async function promptGitHubRepositories({
  message,
  options,
  initialValues = [],
  maxItems,
}: PromptGitHubRepositoriesOptions): Promise<symbol | ActionValue | string[]> {
  const prompt = new GitHubRepoPrompt({
    message,
    options,
    initialValues,
    maxItems,
  });
  return (await prompt.prompt()) as symbol | ActionValue | string[];
}
/* v8 ignore stop */

export class GitHubRepoPrompt extends Prompt {
  options: PromptOption[];
  message: string;
  maxItems?: number;
  cursor = 0;
  private selected: string[];

  constructor({ message, options, initialValues = [], maxItems }: PromptGitHubRepositoriesOptions) {
    super(
      {
        render() {
          return (this as GitHubRepoPrompt).renderPrompt();
        },
      },
      false,
    );

    this.message = message;
    this.options = options;
    this.maxItems = maxItems;
    this.selected = initialValues.filter((value) =>
      options.some((option) => option.kind === "repo" && option.value === value),
    );
    const initialCursor = this.options.findIndex(
      (option) => option.kind === "repo" && this.selected.includes(option.value),
    );
    this.cursor = initialCursor >= 0 ? initialCursor : this.firstFocusableIndex();
    this.syncValue();

    this.on("key", (key) => {
      if (key === "a") {
        this.toggleAll();
        this.syncValue();
      }
    });

    this.on("cursor", (key) => {
      switch (key) {
        case "left":
        case "up":
          this.cursor = this.advanceCursor(-1);
          break;
        case "down":
        case "right":
          this.cursor = this.advanceCursor(1);
          break;
        case "space":
          this.toggleCurrent();
          break;
      }
      this.syncValue();
    });
  }

  private firstFocusableIndex(): number {
    const idx = this.options.findIndex((option) => option.kind !== "separator");
    return idx >= 0 ? idx : 0;
  }

  private advanceCursor(direction: 1 | -1): number {
    const total = this.options.length;
    if (total === 0) return 0;
    let next = this.cursor;
    for (let i = 0; i < total; i++) {
      next = (next + direction + total) % total;
      if (this.options[next].kind !== "separator") return next;
    }
    return this.cursor;
  }

  private get currentOption(): PromptOption {
    return this.options[this.cursor] ?? this.options[0];
  }

  private syncValue(): void {
    this.value =
      this.currentOption.kind === "action" ? this.currentOption.value : [...this.selected];
  }

  private toggleCurrent(): void {
    const current = this.currentOption;
    if (current.kind !== "repo") return;
    const selected = this.selected.includes(current.value);
    this.selected = selected
      ? this.selected.filter((value) => value !== current.value)
      : [...this.selected, current.value];
  }

  private toggleAll(): void {
    const repoValues = this.options
      .filter((option): option is Extract<PromptOption, { kind: "repo" }> => option.kind === "repo")
      .map((option) => option.value);
    this.selected = this.selected.length === repoValues.length ? [] : repoValues;
  }

  private renderPrompt(): string {
    const symbolByState =
      this.state === "submit"
        ? pc.green(SUBMIT_SYMBOL)
        : this.state === "cancel"
          ? pc.red(CANCEL_SYMBOL)
          : pc.cyan(ACTIVE_SYMBOL);
    const header = `${pc.gray(BAR)}
${symbolByState}  ${this.message}
`;

    if (this.state === "submit") {
      return `${header}${pc.gray(BAR)}  ${pc.dim(this.submitLabel())}`;
    }

    if (this.state === "cancel") {
      return `${header}${pc.gray(BAR)}`;
    }

    const body = visibleOptions(this.cursor, this.options, this.maxItems).map((option) => {
      if (option.kind === "ellipsis") {
        return `${pc.gray(BAR)}  ${pc.dim(ELLIPSIS)}`;
      }

      const current = this.options[option.index];
      if (current.kind === "separator") {
        return `${pc.gray(BAR)}  ${pc.dim(SEPARATOR_LINE)}`;
      }

      const isActive = option.index === this.cursor;
      const marker =
        current.kind === "action"
          ? isActive
            ? pc.cyan(ACTION_ARROW)
            : pc.dim(ACTION_ARROW)
          : this.selected.includes(current.value)
            ? isActive
              ? pc.cyan(CHECKBOX_ON)
              : CHECKBOX_ON
            : isActive
              ? pc.cyan(CHECKBOX_OFF)
              : CHECKBOX_OFF;
      const label = isActive ? pc.cyan(current.label) : current.label;
      const hint = current.hint ? ` ${pc.dim(`(${current.hint})`)}` : "";
      return `${pc.gray(BAR)}  ${marker} ${label}${hint}`;
    });

    return `${header}${body.join("\n")}
${pc.cyan(FOOTER)}`;
  }

  private submitLabel(): string {
    if (typeof this.value === "string") {
      const matched = this.options.find(
        (option) => option.kind === "action" && option.value === this.value,
      );
      if (matched && matched.kind === "action") return matched.label;
      const fallback = this.options.find((option) => option.kind === "action");
      return fallback && fallback.kind === "action" ? fallback.label : "Add repositories...";
    }

    const selectedValues = Array.isArray(this.value) ? this.value : [];
    if (selectedValues.length === 0) {
      return "No repositories selected.";
    }

    return selectedValues.join(", ");
  }
}

function visibleOptions(
  cursor: number,
  options: PromptOption[],
  maxItems?: number,
): Array<{ kind: "ellipsis" } | { kind: "option"; index: number }> {
  const terminalRows = process.stdout.rows ? Math.max(process.stdout.rows - 4, 0) : options.length;
  const visibleCount = Math.min(terminalRows || options.length, Math.max(maxItems ?? Infinity, 5));

  if (visibleCount >= options.length) {
    return options.map((_, index) => ({ kind: "option" as const, index }));
  }

  let start = 0;
  if (cursor >= start + visibleCount - 3) {
    start = Math.max(Math.min(cursor - visibleCount + 3, options.length - visibleCount), 0);
  } else if (cursor < start + 2) {
    start = Math.max(cursor - 2, 0);
  }

  const hasTopEllipsis = visibleCount < options.length && start > 0;
  const hasBottomEllipsis = visibleCount < options.length && start + visibleCount < options.length;

  return options.slice(start, start + visibleCount).map((_, index, sliced) => {
    const isTopEllipsis = index === 0 && hasTopEllipsis;
    const isBottomEllipsis = index === sliced.length - 1 && hasBottomEllipsis;
    if (isTopEllipsis || isBottomEllipsis) {
      return { kind: "ellipsis" as const };
    }
    return { kind: "option" as const, index: start + index };
  });
}
