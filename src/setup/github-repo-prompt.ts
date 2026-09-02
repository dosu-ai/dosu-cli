/**
 * The GitHub repository picker, rendered in Dosu's own prompt language
 * (tui/prompts.ts) instead of clack's: a multiselect over repos plus
 * action rows ("Add repositories...", "Refresh list") that submit on
 * enter, separator rows, disabled rows the cursor skips (forks and
 * already-connected repos), viewport windowing for long lists, and an
 * empty-selection guard so enter can never submit nothing.
 *
 * The controller is pure (render + handle) so tests drive it without a
 * TTY; `promptGitHubRepositories` wires it to the kit's frame runner.
 */

import pc from "picocolors";
import {
  answeredEcho,
  type FrameAction,
  type FrameController,
  type PromptIO,
  runInteractive,
} from "../tui/prompts";
import { brand } from "./styles";

const ESC = String.fromCharCode(27);
const KEY_UP = `${ESC}[A`;
const KEY_DOWN = `${ESC}[B`;
const KEY_LEFT = `${ESC}[D`;
const KEY_RIGHT = `${ESC}[C`;
const CTRL_C = String.fromCharCode(3);

const POINTER = "\u25B8";
const BOX_ON = "\u25A0";
const BOX_OFF = "\u25A1";
const DOT = "\u00B7";
const ACTION_ARROW = "\u2192";
const ELLIPSIS = "...";
const SEPARATOR_LINE = "\u2500".repeat(30);

/** Always-visible key legend rendered on the footer line. */
export const KEYS_HINT = `\u2191\u2193 move ${DOT} space toggle ${DOT} a all ${DOT} enter confirm ${DOT} esc cancel`;

export const ADD_REPOSITORIES_VALUE = "__add_repositories__" as const;
export const REFRESH_LIST_VALUE = "__refresh_list__" as const;

type ActionValue = typeof ADD_REPOSITORIES_VALUE | typeof REFRESH_LIST_VALUE;

/**
 * Submit guard: an empty repo selection is never a valid submission — enter
 * without any space-selected repo re-renders with a hint instead of silently
 * advancing (action options submit as strings and always pass).
 */
export function validateRepoSelection(
  value: ActionValue | string[] | undefined,
): string | undefined {
  if (Array.isArray(value) && value.length === 0) {
    return "Select at least one repository (space to select, enter to confirm).";
  }
  return undefined;
}

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
      /**
       * Rendered dimmed and skipped by cursor/selection — used for repos the
       * backend can never sync (forks), mirroring the web attach modal.
       */
      disabled?: boolean;
    };

function isFocusable(option: PromptOption): boolean {
  if (option.kind === "separator") return false;
  return !(option.kind === "repo" && option.disabled === true);
}

interface PromptGitHubRepositoriesOptions {
  message: string;
  options: PromptOption[];
  initialValues?: string[];
  maxItems?: number;
}

export function promptGitHubRepositories(
  opts: PromptGitHubRepositoriesOptions,
  io: PromptIO = {},
): Promise<symbol | ActionValue | string[]> {
  return runInteractive(new GitHubRepoPrompt(opts), io);
}

export class GitHubRepoPrompt implements FrameController<ActionValue | string[]> {
  cursor = 0;
  private readonly message: string;
  private readonly options: PromptOption[];
  private readonly maxItems?: number;
  private selected: string[];
  private error?: string;

  constructor({ message, options, initialValues = [], maxItems }: PromptGitHubRepositoriesOptions) {
    this.message = message;
    this.options = options;
    this.maxItems = maxItems;
    this.selected = initialValues.filter((value) =>
      options.some(
        (option) => option.kind === "repo" && !option.disabled && option.value === value,
      ),
    );
    const initialCursor = this.options.findIndex(
      (option) => option.kind === "repo" && this.selected.includes(option.value),
    );
    this.cursor = initialCursor >= 0 ? initialCursor : this.firstFocusableIndex();
  }

  /** Space-selected repo values, in option order (for tests and the echo line). */
  selectedValues(): string[] {
    return this.reposInOptionOrder().map((option) => option.value);
  }

  render(): string[] {
    const rows = visibleOptions(this.cursor, this.options, this.maxItems).map((slot) => {
      if (slot.kind === "ellipsis") return pc.dim(ELLIPSIS);

      const option = this.options[slot.index];
      if (option.kind === "separator") return pc.dim(SEPARATOR_LINE);

      if (option.kind === "repo" && option.disabled) {
        const hint = option.hint ? ` (${option.hint})` : "";
        return pc.dim(`  ${BOX_OFF} ${option.label}${hint}`);
      }

      const active = slot.index === this.cursor;
      const pointer = active ? brand(POINTER) : " ";
      const label = active ? pc.bold(brand(option.label)) : pc.dim(option.label);
      const hint = option.hint ? `   ${pc.dim(`(${option.hint})`)}` : "";
      const marker =
        option.kind === "action"
          ? active
            ? brand(ACTION_ARROW)
            : pc.dim(ACTION_ARROW)
          : this.selected.includes(option.value)
            ? brand(BOX_ON)
            : pc.dim(BOX_OFF);
      return `${pointer} ${marker} ${label}${hint}`;
    });

    return [
      pc.bold(this.message),
      "",
      ...rows,
      "",
      this.error ? pc.yellow(this.error) : pc.dim(KEYS_HINT),
    ];
  }

  handle(key: string): FrameAction<ActionValue | string[]> {
    if (key === CTRL_C || key === ESC || key === "q") return { type: "cancel" };
    if (key === KEY_UP || key === KEY_LEFT || key === "k") return this.move(-1);
    if (key === KEY_DOWN || key === KEY_RIGHT || key === "j" || key === "\t") return this.move(1);
    if (key === " ") {
      this.toggleCurrent();
      this.error = undefined;
      return { type: "render" };
    }
    if (key === "a") {
      this.toggleAll();
      this.error = undefined;
      return { type: "render" };
    }
    if (key === "\r" || key === "\n") return this.submit();
    return { type: "none" };
  }

  private submit(): FrameAction<ActionValue | string[]> {
    const current = this.options[this.cursor];
    if (current?.kind === "action") {
      return {
        type: "done",
        value: current.value,
        echo: answeredEcho(this.message, current.label),
      };
    }

    const chosen = this.reposInOptionOrder();
    const invalid = validateRepoSelection(chosen.map((option) => option.value));
    if (invalid) {
      this.error = invalid;
      return { type: "render" };
    }
    // Name the picks when they fit on a line; count them otherwise.
    const answer =
      chosen.length <= 3
        ? chosen.map((option) => option.label).join(` ${DOT} `)
        : `${chosen.length} selected`;
    return {
      type: "done",
      value: chosen.map((option) => option.value),
      echo: answeredEcho(this.message, answer),
    };
  }

  private move(direction: 1 | -1): FrameAction<ActionValue | string[]> {
    this.cursor = this.advanceCursor(direction);
    this.error = undefined;
    return { type: "render" };
  }

  private firstFocusableIndex(): number {
    const idx = this.options.findIndex(isFocusable);
    return idx >= 0 ? idx : 0;
  }

  private advanceCursor(direction: 1 | -1): number {
    const total = this.options.length;
    if (total === 0) return 0;
    let next = this.cursor;
    for (let i = 0; i < total; i++) {
      next = (next + direction + total) % total;
      if (isFocusable(this.options[next])) return next;
    }
    return this.cursor;
  }

  private reposInOptionOrder(): Array<Extract<PromptOption, { kind: "repo" }>> {
    return this.options.filter(
      (option): option is Extract<PromptOption, { kind: "repo" }> =>
        option.kind === "repo" && this.selected.includes(option.value),
    );
  }

  private toggleCurrent(): void {
    const current = this.options[this.cursor];
    if (current?.kind !== "repo" || current.disabled) return;
    this.selected = this.selected.includes(current.value)
      ? this.selected.filter((value) => value !== current.value)
      : [...this.selected, current.value];
  }

  private toggleAll(): void {
    const repoValues = this.options
      .filter(
        (option): option is Extract<PromptOption, { kind: "repo" }> =>
          option.kind === "repo" && !option.disabled,
      )
      .map((option) => option.value);
    this.selected = this.selected.length === repoValues.length ? [] : repoValues;
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
