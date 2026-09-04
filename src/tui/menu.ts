/** Custom interactive menu (main-screen replacement for clack's select): arrows/j/k, enter,
 * 1-9 jump-select, q/esc/ctrl-c cancel; erases itself on confirm. */

import pc from "picocolors";
import { brand } from "../setup/styles";
import { visibleWidth } from "./layout";

const ESC = String.fromCharCode(27);
const HIDE_CURSOR = `${ESC}[?25l`;
const SHOW_CURSOR = `${ESC}[?25h`;
const KEY_UP = `${ESC}[A`;
const KEY_DOWN = `${ESC}[B`;
const CTRL_C = String.fromCharCode(3);
const POINTER = "\u25B8";

export interface MenuOption {
  value: string;
  label: string;
  hint?: string;
}

/** Split a raw stdin chunk into individual key presses. */
export function parseKeys(chunk: string): string[] {
  const keys: string[] = [];
  let i = 0;
  while (i < chunk.length) {
    if (chunk[i] === ESC && chunk[i + 1] === "[") {
      let j = i + 2;
      while (j < chunk.length && !/[a-zA-Z~]/.test(chunk[j])) j++;
      keys.push(chunk.slice(i, j + 1));
      i = j + 1;
    } else {
      keys.push(chunk[i]);
      i++;
    }
  }
  return keys;
}

export type MenuAction =
  | { type: "move"; index: number }
  | { type: "submit"; index: number }
  | { type: "cancel" }
  | { type: "none" };

/** Map one key press onto the menu state. */
export function reduceMenuKey(key: string, selected: number, count: number): MenuAction {
  if (key === KEY_UP || key === "k") return { type: "move", index: (selected - 1 + count) % count };
  if (key === KEY_DOWN || key === "j" || key === "\t") {
    return { type: "move", index: (selected + 1) % count };
  }
  if (key === "\r" || key === "\n") return { type: "submit", index: selected };
  if (key === CTRL_C || key === ESC || key === "q") return { type: "cancel" };
  if (key >= "1" && key <= "9") {
    const index = key.charCodeAt(0) - "1".charCodeAt(0);
    if (index < count) return { type: "submit", index };
  }
  return { type: "none" };
}

/** Render the full menu block, anchored to the content column's left edge. */
export function renderMenuFrame(
  message: string,
  options: readonly MenuOption[],
  selected: number,
): string {
  // Pad by visible width so colored labels (e.g. the mining dot) stay aligned.
  const labelWidth = Math.max(...options.map((option) => visibleWidth(option.label)));
  const rows = options.map((option, index) => {
    const label = option.label + " ".repeat(labelWidth - visibleWidth(option.label));
    const hint = option.hint ? `   ${pc.dim(option.hint)}` : "";
    return index === selected
      ? `${brand(POINTER)} ${pc.bold(label)}${hint}`
      : `  ${pc.dim(label)}${hint}`;
  });
  const lines = [
    pc.bold(message),
    "",
    ...rows,
    "",
    pc.dim("\u2191\u2193 move \u00B7 enter select \u00B7 q quit"),
  ];
  // Left-anchored like every other TUI surface; the injected margin centers
  // the column as a whole.
  return lines.join("\n");
}

export interface MenuIO {
  input?: NodeJS.ReadStream;
  output?: NodeJS.WriteStream;
  /** Live refresh: poll `options()` and repaint in place when they change; `redrawScreen` runs
   * first so the caller can repaint the banner. */
  refresh?: {
    /** Poll cadence; defaults to 1s (matches the Activity view's poll). */
    intervalMs?: number;
    /** Rebuild the option rows from live state. */
    options: () => MenuOption[];
    /** Repaint the screen content above the menu (may clear the screen). */
    redrawScreen?: () => void;
  };
}

function sameOptions(a: readonly MenuOption[], b: readonly MenuOption[]): boolean {
  return (
    a.length === b.length &&
    a.every(
      (option, i) =>
        option.value === b[i].value && option.label === b[i].label && option.hint === b[i].hint,
    )
  );
}

/** Show the menu and resolve with the chosen value, or null on cancel or non-interactive stdin. */
export function menuSelect(
  message: string,
  options: readonly MenuOption[],
  io: MenuIO = {},
): Promise<string | null> {
  const input = io.input ?? process.stdin;
  const output = io.output ?? process.stdout;
  if (!input.isTTY) return Promise.resolve(null);

  let currentOptions = options;
  let selected = 0;
  let frameLines = 0;

  const erase = () => {
    if (frameLines > 0) output.write(`${ESC}[${frameLines}A${ESC}[0J`);
    frameLines = 0;
  };
  const draw = () => {
    const frame = renderMenuFrame(message, currentOptions, selected);
    erase();
    output.write(`${frame}\n`);
    frameLines = frame.split("\n").length;
  };

  output.write(HIDE_CURSOR);
  draw();

  const timer = io.refresh
    ? setInterval(() => {
        const next = io.refresh?.options() ?? [];
        if (next.length === 0 || sameOptions(next, currentOptions)) return;
        currentOptions = next;
        if (selected >= next.length) selected = next.length - 1;
        // Erase the stale frame first; redrawScreen may or may not clear the screen.
        erase();
        io.refresh?.redrawScreen?.();
        draw();
      }, io.refresh.intervalMs ?? 1000)
    : undefined;

  return new Promise((resolve) => {
    const wasRaw = input.isRaw ?? false;
    input.setRawMode?.(true);
    input.resume();

    const finish = (value: string | null) => {
      if (timer) clearInterval(timer);
      input.off("data", onData);
      input.setRawMode?.(wasRaw);
      input.pause();
      erase();
      output.write(SHOW_CURSOR);
      resolve(value);
    };

    const onData = (chunk: Buffer | string) => {
      for (const key of parseKeys(chunk.toString())) {
        const action = reduceMenuKey(key, selected, currentOptions.length);
        if (action.type === "move") {
          selected = action.index;
          draw();
        } else if (action.type === "submit") {
          finish(currentOptions[action.index].value);
          return;
        } else if (action.type === "cancel") {
          finish(null);
          return;
        }
      }
    };
    input.on("data", onData);
  });
}
