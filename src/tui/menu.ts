/**
 * Custom interactive menu — the main-screen replacement for clack's select.
 *
 * Renders a centered block: bold prompt, options with a brand-green cursor
 * and aligned dim hints, and a key legend. Arrow keys / j / k move, enter
 * confirms, 1-9 jump-selects, and q / esc / ctrl-c cancel. On confirm the
 * menu erases itself completely — every choice launches a flow that renders
 * its own header, so an echo line would just duplicate it.
 *
 * The rendering and key handling are pure functions so tests can drive the
 * component without a TTY; `menuSelect` wires them to (injectable) streams.
 */

import pc from "picocolors";
import { brand } from "../setup/styles";
import { centerBlock, contentWidth, visibleWidth } from "./layout";

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

/** Render the full menu block, centered within `width` columns. */
export function renderMenuFrame(
  message: string,
  options: readonly MenuOption[],
  selected: number,
  width: number,
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
  return centerBlock(lines, width).join("\n");
}

export interface MenuIO {
  input?: NodeJS.ReadStream;
  output?: NodeJS.WriteStream;
}

/**
 * Show the menu and resolve with the chosen option's value, or null when
 * the user cancels (q / esc / ctrl-c) or stdin isn't interactive.
 */
export function menuSelect(
  message: string,
  options: readonly MenuOption[],
  io: MenuIO = {},
): Promise<string | null> {
  const input = io.input ?? process.stdin;
  const output = io.output ?? process.stdout;
  if (!input.isTTY) return Promise.resolve(null);

  const width = contentWidth(output.columns ?? 80);
  let selected = 0;
  let frameLines = 0;

  const erase = () => {
    if (frameLines > 0) output.write(`${ESC}[${frameLines}A${ESC}[0J`);
    frameLines = 0;
  };
  const draw = () => {
    const frame = renderMenuFrame(message, options, selected, width);
    erase();
    output.write(`${frame}\n`);
    frameLines = frame.split("\n").length;
  };

  output.write(HIDE_CURSOR);
  draw();

  return new Promise((resolve) => {
    const wasRaw = input.isRaw ?? false;
    input.setRawMode?.(true);
    input.resume();

    const finish = (value: string | null) => {
      input.off("data", onData);
      input.setRawMode?.(wasRaw);
      input.pause();
      erase();
      output.write(SHOW_CURSOR);
      resolve(value);
    };

    const onData = (chunk: Buffer | string) => {
      for (const key of parseKeys(chunk.toString())) {
        const action = reduceMenuKey(key, selected, options.length);
        if (action.type === "move") {
          selected = action.index;
          draw();
        } else if (action.type === "submit") {
          finish(options[action.index].value);
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
