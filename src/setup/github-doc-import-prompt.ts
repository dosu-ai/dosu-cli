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

const CHECKBOX_PARTIAL = symbol("◧", "[-]");
const MAX_VISIBLE_FILE_ITEMS = 15;

export interface GitHubImportFileOption {
  id: string;
  path: string;
  is_synced?: boolean;
}

export interface GitHubImportRepositoryOption {
  slug: string;
  files: GitHubImportFileOption[];
}

type PromptMode = "repos" | "files";
type RepoSelectionState = "none" | "partial" | "all" | "locked";

interface PromptGitHubDocsImportOptions {
  repositories: GitHubImportRepositoryOption[];
}

interface KeyInfo {
  ctrl?: boolean;
  name?: string;
}

/* v8 ignore start -- TTY-only wrapper; logic covered via GitHubDocsImportPrompt tests */
export async function promptGitHubDocsImport({
  repositories,
}: PromptGitHubDocsImportOptions): Promise<symbol | string[]> {
  const prompt = new GitHubDocsImportPrompt({ repositories });
  return (await prompt.prompt()) as symbol | string[];
}
/* v8 ignore stop */

export class GitHubDocsImportPrompt extends Prompt {
  repositories: GitHubImportRepositoryOption[];
  mode: PromptMode = "repos";
  repoCursor = 0;
  fileCursor = 0;
  searchQuery = "";
  searchActive = false;
  private selectedIds = new Set<string>();

  constructor({ repositories }: PromptGitHubDocsImportOptions) {
    super(
      {
        render() {
          return (this as GitHubDocsImportPrompt).renderPrompt();
        },
      },
      false,
    );

    this.repositories = repositories;
    this.selectedIds = new Set(
      repositories.flatMap((repository) => getSelectableFileIds(repository.files)),
    );
    this.syncValue();
    // `@clack/core` stores the bound handler on the instance; replace it with
    // our custom handler so repo/file mode can own Enter / Escape semantics.
    // biome-ignore lint/suspicious/noExplicitAny: internal prompt hook
    (this as any).onKeypress = this.handleRawKeypress.bind(this);
  }

  handleRawKeypress(key?: string, info?: KeyInfo): void {
    this.handleKeypress(key, info);
    this.syncValue();
    // biome-ignore lint/suspicious/noExplicitAny: internal prompt hook
    if ((this as any).rl) {
      // biome-ignore lint/suspicious/noExplicitAny: internal prompt hook
      (this as any).render();
    }

    // biome-ignore lint/suspicious/noExplicitAny: internal prompt hook
    if ((this.state === "submit" || this.state === "cancel") && (this as any).rl) {
      this.close();
    }
  }

  handleKeypress(key?: string, info?: KeyInfo): void {
    if (info?.ctrl && info.name === "c") {
      this.state = "cancel";
      return;
    }

    if (this.mode === "repos") {
      this.handleRepoModeKey(info);
      return;
    }

    this.handleFileModeKey(key, info);
  }

  private handleRepoModeKey(info?: KeyInfo): void {
    switch (info?.name) {
      case "up":
        this.moveRepoCursor(-1);
        return;
      case "down":
        this.moveRepoCursor(1);
        return;
      case "right":
        this.enterRepository();
        return;
      case "space":
        this.toggleCurrentRepository();
        return;
      case "return":
        this.state = "submit";
        return;
      case "left":
        return;
      case "escape":
        this.state = "cancel";
        return;
      default:
        return;
    }
  }

  private handleFileModeKey(key?: string, info?: KeyInfo): void {
    switch (info?.name) {
      case "up":
        this.moveFileCursor(-1);
        return;
      case "down":
        this.moveFileCursor(1);
        return;
      case "left":
        this.leaveRepository();
        return;
      case "space":
        this.toggleCurrentFile();
        return;
      case "backspace":
        this.searchQuery = this.searchQuery.slice(0, -1);
        this.searchActive = this.searchQuery.length > 0;
        this.resetFileCursor();
        return;
      case "return":
        this.leaveRepository();
        return;
      case "escape":
        if (this.searchQuery || this.searchActive) {
          this.searchQuery = "";
          this.searchActive = false;
          this.resetFileCursor();
          return;
        }
        this.state = "cancel";
        return;
      default:
        break;
    }

    if (!key) return;

    if (key === "/") {
      this.searchActive = true;
      return;
    }

    if (key === "a" && !this.searchActive && this.searchQuery.length === 0) {
      this.toggleAllVisibleFiles();
      return;
    }

    if (!isPrintableKey(key)) return;

    this.searchActive = true;
    this.searchQuery += key;
    this.resetFileCursor();
  }

  private get currentRepository(): GitHubImportRepositoryOption | undefined {
    return this.repositories[this.repoCursor];
  }

  get filteredFiles(): GitHubImportFileOption[] {
    const files = this.currentRepository?.files ?? [];
    const query = this.searchQuery.trim().toLowerCase();
    if (!query) return files;
    return files.filter((file) => file.path.toLowerCase().includes(query));
  }

  private syncValue(): void {
    this.value = Array.from(this.selectedIds);
  }

  private moveRepoCursor(delta: number): void {
    if (this.repositories.length === 0) return;
    this.repoCursor = wrapIndex(this.repoCursor + delta, this.repositories.length);
  }

  private moveFileCursor(delta: number): void {
    if (this.filteredFiles.length === 0) return;
    this.fileCursor = wrapIndex(this.fileCursor + delta, this.filteredFiles.length);
  }

  private enterRepository(): void {
    if (!this.currentRepository) return;
    this.mode = "files";
    this.searchQuery = "";
    this.searchActive = false;
    this.resetFileCursor();
  }

  private leaveRepository(): void {
    this.mode = "repos";
    this.searchQuery = "";
    this.searchActive = false;
    this.fileCursor = 0;
  }

  private resetFileCursor(): void {
    this.fileCursor = 0;
  }

  private toggleCurrentRepository(): void {
    const repo = this.currentRepository;
    if (!repo) return;
    const selectableIds = getSelectableFileIds(repo.files);
    if (selectableIds.length === 0) return;

    const allSelected = selectableIds.every((id) => this.selectedIds.has(id));
    if (allSelected) {
      for (const id of selectableIds) {
        this.selectedIds.delete(id);
      }
      return;
    }

    for (const id of selectableIds) {
      this.selectedIds.add(id);
    }
  }

  private toggleCurrentFile(): void {
    const file = this.filteredFiles[this.fileCursor];
    if (!file || file.is_synced) return;
    if (this.selectedIds.has(file.id)) {
      this.selectedIds.delete(file.id);
      return;
    }
    this.selectedIds.add(file.id);
  }

  private toggleAllVisibleFiles(): void {
    const selectableIds = getSelectableFileIds(this.filteredFiles);
    if (selectableIds.length === 0) return;

    const allSelected = selectableIds.every((id) => this.selectedIds.has(id));
    if (allSelected) {
      for (const id of selectableIds) {
        this.selectedIds.delete(id);
      }
      return;
    }

    for (const id of selectableIds) {
      this.selectedIds.add(id);
    }
  }

  getRepositorySelectionState(repo: GitHubImportRepositoryOption): RepoSelectionState {
    const selectableIds = getSelectableFileIds(repo.files);
    if (selectableIds.length === 0) return "locked";

    let selectedCount = 0;
    for (const id of selectableIds) {
      if (this.selectedIds.has(id)) selectedCount += 1;
    }

    if (selectedCount === 0) return "none";
    if (selectedCount === selectableIds.length) return "all";
    return "partial";
  }

  private renderPrompt(): string {
    const promptSymbol =
      this.state === "submit"
        ? pc.green(SUBMIT_SYMBOL)
        : this.state === "cancel"
          ? pc.red(CANCEL_SYMBOL)
          : pc.cyan(ACTIVE_SYMBOL);
    const title =
      this.mode === "repos" ? "Select docs to import" : (this.currentRepository?.slug ?? "Files");
    const header = `${pc.gray(BAR)}
${promptSymbol}  ${title}
`;

    if (this.state === "submit") {
      return `${header}${pc.gray(BAR)}  ${pc.dim(this.submitLabel())}`;
    }

    if (this.state === "cancel") {
      return `${header}${pc.gray(BAR)}`;
    }

    return this.mode === "repos" ? this.renderRepositoryMode(header) : this.renderFileMode(header);
  }

  private renderRepositoryMode(header: string): string {
    const help = `${pc.gray(BAR)}  ${pc.dim(
      "space: import all docs in a repo   →: browse repo docs   Enter: confirm",
    )}`;
    const body = visibleOptions(this.repoCursor, this.repositories.length).map((option) => {
      if (option.kind === "ellipsis") {
        return `${pc.gray(BAR)}  ${pc.dim(ELLIPSIS)}`;
      }

      const repo = this.repositories[option.index];
      const isActive = option.index === this.repoCursor;
      const state = this.getRepositorySelectionState(repo);
      const marker = this.renderRepositoryMarker(state, isActive);
      const label = isActive ? pc.cyan(repo.slug) : repo.slug;
      const hint = state === "locked" ? ` ${pc.dim("(All docs already imported)")}` : "";
      return `${pc.gray(BAR)}  ${marker} ${label}${hint}`;
    });

    return `${header}${help}
${pc.gray(BAR)}
${body.join("\n")}
${pc.cyan(FOOTER)}`;
  }

  private renderFileMode(header: string): string {
    const back = `${pc.gray(BAR)}  ${pc.dim("←: back / Enter")}`;
    const searchValue = this.searchQuery || pc.dim(this.searchActive ? "" : "type to filter");
    const search = `${pc.gray(BAR)}  Search: ${searchValue}`;
    const help = `${pc.gray(BAR)}  ${pc.dim(
      "space: toggle doc   type: search   a: select all visible   ←: back / Enter",
    )}`;

    const body = visibleOptions(
      this.fileCursor,
      this.filteredFiles.length,
      MAX_VISIBLE_FILE_ITEMS,
    ).map((option) => {
      if (option.kind === "ellipsis") {
        return `${pc.gray(BAR)}  ${pc.dim(ELLIPSIS)}`;
      }

      const file = this.filteredFiles[option.index];
      const isActive = option.index === this.fileCursor;
      const isSelected = this.selectedIds.has(file.id);
      // Synced (disabled) rows still need a visible cursor state when active:
      // the user can't toggle them, but should at least see where the cursor
      // is. Mirror the repo-mode treatment of `locked` rows.
      const marker = file.is_synced
        ? isActive
          ? pc.cyan(CHECKBOX_OFF)
          : pc.dim(CHECKBOX_OFF)
        : isSelected
          ? isActive
            ? pc.cyan(CHECKBOX_ON)
            : CHECKBOX_ON
          : isActive
            ? pc.cyan(CHECKBOX_OFF)
            : CHECKBOX_OFF;
      const label = file.is_synced
        ? isActive
          ? pc.cyan(file.path)
          : pc.dim(file.path)
        : isActive
          ? pc.cyan(file.path)
          : file.path;
      const hint = file.is_synced ? ` ${pc.dim("(Already imported)")}` : "";
      return `${pc.gray(BAR)}  ${marker} ${label}${hint}`;
    });

    const content =
      body.length > 0
        ? body.join("\n")
        : `${pc.gray(BAR)}  ${pc.dim("No docs match your search.")}`;

    return `${header}${back}
${pc.gray(BAR)}
${search}
${pc.gray(BAR)}
${content}
${pc.gray(BAR)}
${help}
${pc.cyan(FOOTER)}`;
  }

  private renderRepositoryMarker(state: RepoSelectionState, isActive: boolean): string {
    if (state === "all") {
      return isActive ? pc.cyan(CHECKBOX_ON) : CHECKBOX_ON;
    }
    if (state === "partial") {
      return isActive ? pc.cyan(CHECKBOX_PARTIAL) : CHECKBOX_PARTIAL;
    }
    if (state === "locked") {
      return isActive ? pc.cyan(CHECKBOX_OFF) : pc.dim(CHECKBOX_OFF);
    }
    return isActive ? pc.cyan(CHECKBOX_OFF) : CHECKBOX_OFF;
  }

  private submitLabel(): string {
    const count = this.selectedIds.size;
    if (count === 0) {
      return "Skip for now";
    }
    return `${count} doc${count === 1 ? "" : "s"} selected`;
  }
}

function getSelectableFileIds(files: GitHubImportFileOption[]): string[] {
  return files.filter((file) => !file.is_synced).map((file) => file.id);
}

function visibleOptions(
  cursor: number,
  totalItems: number,
  maxItems?: number,
): Array<{ kind: "ellipsis" } | { kind: "option"; index: number }> {
  const terminalRows = process.stdout.rows ? Math.max(process.stdout.rows - 8, 0) : totalItems;
  const visibleCount = Math.min(terminalRows || totalItems, Math.max(maxItems ?? Infinity, 5));

  if (visibleCount >= totalItems) {
    return Array.from({ length: totalItems }, (_, index) => ({ kind: "option" as const, index }));
  }

  let start = 0;
  if (cursor >= start + visibleCount - 3) {
    start = Math.max(Math.min(cursor - visibleCount + 3, totalItems - visibleCount), 0);
  } else if (cursor < start + 2) {
    start = Math.max(cursor - 2, 0);
  }

  const hasTopEllipsis = visibleCount < totalItems && start > 0;
  const hasBottomEllipsis = visibleCount < totalItems && start + visibleCount < totalItems;

  return Array.from({ length: visibleCount }, (_, index) => {
    const isTopEllipsis = index === 0 && hasTopEllipsis;
    const isBottomEllipsis = index === visibleCount - 1 && hasBottomEllipsis;
    if (isTopEllipsis || isBottomEllipsis) {
      return { kind: "ellipsis" as const };
    }
    return { kind: "option" as const, index: start + index };
  });
}

function wrapIndex(index: number, length: number): number {
  if (length === 0) return 0;
  if (index < 0) return length - 1;
  if (index >= length) return 0;
  return index;
}

function isPrintableKey(key: string): boolean {
  return key.length === 1 && key >= " " && key !== "\u007f";
}
