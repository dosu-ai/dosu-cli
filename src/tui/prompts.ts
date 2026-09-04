/**
 * Dosu's own prompt kit: a drop-in replacement for the @clack/prompts surface
 * the setup wizard uses. Completed steps collapse into a "✔ Step · detail"
 * ledger; the active question carries a brand-green ▌ bar. Injectable IO.
 */

import pc from "picocolors";
import { brand } from "../setup/styles";
import { contentWidth } from "./layout";
import { parseKeys, reduceMenuKey } from "./menu";

const ESC = String.fromCharCode(27);
const HIDE_CURSOR = `${ESC}[?25l`;
const SHOW_CURSOR = `${ESC}[?25h`;
const CLEAR_LINE = `\r${ESC}[2K`;
const KEY_UP = `${ESC}[A`;
const KEY_DOWN = `${ESC}[B`;
const KEY_LEFT = `${ESC}[D`;
const KEY_RIGHT = `${ESC}[C`;
const CTRL_C = String.fromCharCode(3);

const CHECK = "\u2714";
const CROSS = "\u2716";
const POINTER = "\u25B8";
const BOX_ON = "\u25A0";
const BOX_OFF = "\u25A1";
const DOT = "\u00B7";
const BAR = "\u258C";
const RULE = "\u2500";
const SPINNER_FRAMES = [
  "\u280B",
  "\u2819",
  "\u2839",
  "\u2838",
  "\u283C",
  "\u2834",
  "\u2826",
  "\u2827",
  "\u2807",
  "\u280F",
];

const CANCEL = Symbol.for("dosu.prompt.cancel");

export function isCancel(value: unknown): value is symbol {
  return value === CANCEL;
}

export interface PromptIO {
  input?: NodeJS.ReadStream;
  output?: NodeJS.WriteStream;
}

function resolveIO(io: PromptIO): { input: NodeJS.ReadStream; output: NodeJS.WriteStream } {
  return { input: io.input ?? process.stdin, output: io.output ?? process.stdout };
}

// ---------------------------------------------------------------------------
// Static output
// ---------------------------------------------------------------------------

/** Thin rule that frames the wizard within the content column. */
function rule(output: NodeJS.WriteStream): string {
  return pc.dim(RULE.repeat(contentWidth(output.columns || 80)));
}

export function intro(title: string, io: PromptIO = {}): void {
  const { output } = resolveIO(io);
  output.write(`\n${title}\n${rule(output)}\n\n`);
}

export function outro(message: string, io: PromptIO = {}): void {
  const { output } = resolveIO(io);
  output.write(`\n${rule(output)}\n${message}\n\n`);
}

/** First line gets the marker; continuation lines are indented under it. */
function writeMarked(marker: string, message: string, io: PromptIO): void {
  const [first, ...rest] = message.split("\n");
  const lines = [`${marker} ${first}`, ...rest.map((line) => `  ${line}`)];
  resolveIO(io).output.write(`${lines.join("\n")}\n`);
}

export const log = {
  success(message: string, io: PromptIO = {}): void {
    writeMarked(brand(CHECK), message, io);
  },
  error(message: string, io: PromptIO = {}): void {
    writeMarked(pc.red(CROSS), message, io);
  },
  warn(message: string, io: PromptIO = {}): void {
    writeMarked(pc.yellow("!"), message, io);
  },
  info(message: string, io: PromptIO = {}): void {
    writeMarked(pc.dim(DOT), message, io);
  },
  message(message: string, io: PromptIO = {}): void {
    writeMarked(" ", message, io);
  },
};

// ---------------------------------------------------------------------------
// Spinner
// ---------------------------------------------------------------------------

export interface Spinner {
  start(message?: string): void;
  message(message: string): void;
  stop(message?: string, code?: number): void;
}

export function spinner(io: PromptIO = {}): Spinner {
  const { output } = resolveIO(io);
  const animated = output.isTTY ?? false;
  let text = "";
  let frame = 0;
  let timer: ReturnType<typeof setInterval> | undefined;

  const renderFrame = () => {
    output.write(`${CLEAR_LINE}${brand(SPINNER_FRAMES[frame % SPINNER_FRAMES.length])} ${text}`);
    frame++;
  };

  return {
    start(message = "") {
      text = message;
      if (animated) {
        renderFrame();
        timer = setInterval(renderFrame, 80);
      } else {
        output.write(`${pc.dim(DOT)} ${text}\n`);
      }
    },
    message(message: string) {
      text = message;
    },
    stop(message = text, code = 0) {
      if (timer) clearInterval(timer);
      timer = undefined;
      const marker = code === 0 ? brand(CHECK) : pc.red(CROSS);
      output.write(`${animated ? CLEAR_LINE : ""}${marker} ${message}\n`);
    },
  };
}

// ---------------------------------------------------------------------------
// Interactive prompts
// ---------------------------------------------------------------------------

export type FrameAction<T> =
  | { type: "render" }
  | { type: "done"; value: T; echo?: string }
  | { type: "cancel" }
  | { type: "none" };

export interface FrameController<T> {
  render(): string[];
  handle(key: string): FrameAction<T>;
}

/**
 * Draw/redraw a frame, route keys, and collapse or erase on finish.
 * Exported so bespoke prompts (e.g. the GitHub repo picker) can share the
 * kit's frame machinery and visual language.
 */
export function runInteractive<T>(
  controller: FrameController<T>,
  io: PromptIO = {},
): Promise<T | symbol> {
  const { input, output } = resolveIO(io);
  if (!input.isTTY) return Promise.resolve(CANCEL);

  let frameLines = 0;
  const erase = () => {
    if (frameLines > 0) output.write(`${ESC}[${frameLines}A${ESC}[0J`);
    frameLines = 0;
  };
  // The active question is the only weighted block on screen: every line
  // carries the brand bar, which disappears when the step commits.
  const draw = () => {
    const frame = controller
      .render()
      .flatMap((line) => line.split("\n"))
      .map((line) => `${brand(BAR)} ${line}`)
      .join("\n");
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

    const finish = (value: T | symbol, echo?: string) => {
      input.off("data", onData);
      input.setRawMode?.(wasRaw);
      input.pause();
      erase();
      if (echo) output.write(`${echo}\n`);
      output.write(SHOW_CURSOR);
      resolve(value);
    };

    const onData = (chunk: Buffer | string) => {
      for (const key of parseKeys(chunk.toString())) {
        const action = controller.handle(key);
        if (action.type === "render") draw();
        else if (action.type === "done") {
          finish(action.value, action.echo);
          return;
        } else if (action.type === "cancel") {
          finish(CANCEL);
          return;
        }
      }
    };
    input.on("data", onData);
  });
}

/** The collapsed "✔ message · answer" line prompts leave behind. */
export function answeredEcho(message: string, answer: string): string {
  return `${brand(CHECK)} ${pc.bold(message)} ${pc.dim(`${DOT} ${answer}`)}`;
}

export interface SelectOption<T> {
  value: T;
  label?: string;
  hint?: string;
}

function optionLabel<T>(option: SelectOption<T>): string {
  return option.label ?? String(option.value);
}

export function select<T>(
  opts: { message: string; options: readonly SelectOption<T>[] },
  io: PromptIO = {},
): Promise<T | symbol> {
  let selected = 0;
  const labelWidth = Math.max(...opts.options.map((o) => optionLabel(o).length));

  return runInteractive<T>(
    {
      render() {
        const rows = opts.options.map((option, index) => {
          const label = optionLabel(option).padEnd(labelWidth);
          const hint = option.hint ? `   ${pc.dim(option.hint)}` : "";
          return index === selected
            ? `${brand(POINTER)} ${pc.bold(brand(label))}${hint}`
            : `  ${pc.dim(label)}${hint}`;
        });
        return [
          pc.bold(opts.message),
          "",
          ...rows,
          "",
          pc.dim(`\u2191\u2193 move ${DOT} enter select ${DOT} esc cancel`),
        ];
      },
      handle(key) {
        const action = reduceMenuKey(key, selected, opts.options.length);
        if (action.type === "move") {
          selected = action.index;
          return { type: "render" };
        }
        if (action.type === "submit") {
          const choice = opts.options[action.index];
          return {
            type: "done",
            value: choice.value,
            echo: answeredEcho(opts.message, optionLabel(choice)),
          };
        }
        if (action.type === "cancel") return { type: "cancel" };
        return { type: "none" };
      },
    },
    io,
  );
}

export function multiselect<T>(
  opts: {
    message: string;
    options: readonly SelectOption<T>[];
    initialValues?: readonly T[];
    /**
     * Live per-row status that reacts to the checkbox, replacing the static
     * `hint`. Returned strings are rendered as-is, so the caller owns color.
     */
    statusFor?: (value: T, picked: boolean) => string | undefined;
    /** Live one-line preview of what confirming would do, shown above the legend. */
    summary?: (picked: readonly T[]) => string | undefined;
    /** Returns a message to block confirm with; undefined lets it through. */
    validate?: (picked: readonly T[]) => string | undefined;
  },
  io: PromptIO = {},
): Promise<T[] | symbol> {
  const { output } = resolveIO(io);
  let cursor = 0;
  let top = 0;
  let error: string | undefined;
  const picked = new Set<T>(opts.initialValues ?? []);
  // Long values (folder paths) keep their tail — the distinguishing part —
  // so a row can never wrap and corrupt the in-place repaint.
  const maxLabel = Math.max(16, contentWidth(output.columns || 80) - 8);
  const clipLabel = (text: string) =>
    text.length <= maxLabel ? text : `\u2026${text.slice(text.length - maxLabel + 1)}`;
  const labelWidth = Math.max(...opts.options.map((o) => clipLabel(optionLabel(o)).length));
  const pickedValues = () =>
    opts.options.filter((option) => picked.has(option.value)).map((option) => option.value);

  return runInteractive<T[]>(
    {
      render() {
        // Scrolling viewport: never draw more rows than the terminal holds
        // (an overflowing frame can't be erased and stacks on repaint).
        const count = opts.options.length;
        const visible = Math.min(count, Math.max(4, (output.rows ?? 24) - 9));
        if (cursor < top) top = cursor;
        if (cursor >= top + visible) top = cursor - visible + 1;
        top = Math.max(0, Math.min(top, count - visible));

        const rows = opts.options.slice(top, top + visible).map((option, offset) => {
          const index = top + offset;
          const isPicked = picked.has(option.value);
          const box = isPicked ? brand(BOX_ON) : pc.dim(BOX_OFF);
          const label = clipLabel(optionLabel(option)).padEnd(labelWidth);
          const status = opts.statusFor
            ? opts.statusFor(option.value, isPicked)
            : option.hint && pc.dim(option.hint);
          const suffix = status ? `   ${status}` : "";
          return index === cursor
            ? `${brand(POINTER)} ${box} ${pc.bold(brand(label))}${suffix}`
            : `  ${box} ${pc.dim(label)}${suffix}`;
        });
        const above = top;
        const below = count - top - visible;
        const summary = opts.summary?.(pickedValues());
        return [
          pc.bold(opts.message),
          "",
          ...(above > 0 ? [pc.dim(`  \u2191 ${above} more`)] : []),
          ...rows,
          ...(below > 0 ? [pc.dim(`  \u2193 ${below} more`)] : []),
          "",
          ...(error ? [pc.yellow(error)] : summary ? [pc.dim(summary)] : []),
          pc.dim(
            `\u2191\u2193 move ${DOT} space toggle ${DOT} a all ${DOT} enter confirm ${DOT} esc cancel`,
          ),
        ];
      },
      handle(key) {
        if (key === " ") {
          error = undefined;
          const value = opts.options[cursor].value;
          if (picked.has(value)) picked.delete(value);
          else picked.add(value);
          return { type: "render" };
        }
        if (key === "a" || key === "A") {
          // Toggle all: everything picked clears to none, anything less picks all.
          error = undefined;
          if (picked.size === opts.options.length) picked.clear();
          else for (const option of opts.options) picked.add(option.value);
          return { type: "render" };
        }
        if (key === KEY_UP || key === "k") {
          cursor = (cursor - 1 + opts.options.length) % opts.options.length;
          return { type: "render" };
        }
        if (key === KEY_DOWN || key === "j" || key === "\t") {
          cursor = (cursor + 1) % opts.options.length;
          return { type: "render" };
        }
        if (key === "\r" || key === "\n") {
          const blocked = opts.validate?.(pickedValues());
          if (blocked) {
            error = blocked;
            return { type: "render" };
          }
          const chosen = opts.options.filter((option) => picked.has(option.value));
          // Name the picks when they fit on a line; count them otherwise.
          const answer =
            chosen.length === 0
              ? "none"
              : chosen.length <= 3
                ? chosen.map(optionLabel).join(` ${DOT} `)
                : `${chosen.length} selected`;
          return {
            type: "done",
            value: chosen.map((option) => option.value),
            echo: answeredEcho(opts.message, answer),
          };
        }
        if (key === CTRL_C || key === ESC || key === "q") return { type: "cancel" };
        return { type: "none" };
      },
    },
    io,
  );
}

export function confirm(
  opts: { message: string; active?: string; inactive?: string; initialValue?: boolean },
  io: PromptIO = {},
): Promise<boolean | symbol> {
  let yes = opts.initialValue ?? true;
  const yesLabel = opts.active ?? "Yes";
  const noLabel = opts.inactive ?? "No";

  const choice = (label: string, active: boolean) =>
    active ? `${brand(POINTER)} ${pc.bold(brand(label))}` : `  ${pc.dim(label)}`;

  return runInteractive<boolean>(
    {
      render() {
        return [
          pc.bold(opts.message),
          "",
          `${choice(yesLabel, yes)}   ${choice(noLabel, !yes)}`,
          "",
          pc.dim(`\u2190\u2192 move ${DOT} enter confirm ${DOT} esc cancel`),
        ];
      },
      handle(key) {
        if (key === KEY_LEFT || key === KEY_RIGHT || key === "h" || key === "l" || key === "\t") {
          yes = !yes;
          return { type: "render" };
        }
        if (key === "y" || key === "Y") {
          return { type: "done", value: true, echo: answeredEcho(opts.message, yesLabel) };
        }
        if (key === "n" || key === "N") {
          return { type: "done", value: false, echo: answeredEcho(opts.message, noLabel) };
        }
        if (key === "\r" || key === "\n") {
          return {
            type: "done",
            value: yes,
            echo: answeredEcho(opts.message, yes ? yesLabel : noLabel),
          };
        }
        if (key === CTRL_C || key === ESC || key === "q") return { type: "cancel" };
        return { type: "none" };
      },
    },
    io,
  );
}
