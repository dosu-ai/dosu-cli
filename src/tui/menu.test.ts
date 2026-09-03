import { EventEmitter } from "node:events";
import { describe, expect, it, vi } from "vitest";
import { type MenuOption, menuSelect, parseKeys, reduceMenuKey, renderMenuFrame } from "./menu";

const ESC = String.fromCharCode(27);
const UP = `${ESC}[A`;
const DOWN = `${ESC}[B`;
const CTRL_C = String.fromCharCode(3);

function stripAnsi(text: string): string {
  return text.replace(new RegExp(`${ESC}\\[[0-9;?]*[A-Za-z]`, "g"), "");
}

const OPTIONS: MenuOption[] = [
  { value: "setup", label: "Setup", hint: "Connect Dosu to your AI agents" },
  { value: "auth", label: "Authenticate" },
  { value: "exit", label: "Exit" },
];

describe("parseKeys", () => {
  it("splits plain characters", () => {
    expect(parseKeys("jk\r")).toEqual(["j", "k", "\r"]);
  });

  it("keeps escape sequences intact", () => {
    expect(parseKeys(`${UP}${DOWN}q`)).toEqual([UP, DOWN, "q"]);
  });
});

describe("reduceMenuKey", () => {
  it("moves with arrows and vim keys, wrapping", () => {
    expect(reduceMenuKey(DOWN, 0, 3)).toEqual({ type: "move", index: 1 });
    expect(reduceMenuKey("j", 2, 3)).toEqual({ type: "move", index: 0 });
    expect(reduceMenuKey(UP, 0, 3)).toEqual({ type: "move", index: 2 });
    expect(reduceMenuKey("k", 1, 3)).toEqual({ type: "move", index: 0 });
  });

  it("submits on enter and number keys", () => {
    expect(reduceMenuKey("\r", 1, 3)).toEqual({ type: "submit", index: 1 });
    expect(reduceMenuKey("3", 0, 3)).toEqual({ type: "submit", index: 2 });
  });

  it("ignores number keys beyond the option count", () => {
    expect(reduceMenuKey("9", 0, 3)).toEqual({ type: "none" });
  });

  it("cancels on q, esc, and ctrl-c", () => {
    expect(reduceMenuKey("q", 0, 3)).toEqual({ type: "cancel" });
    expect(reduceMenuKey(ESC, 0, 3)).toEqual({ type: "cancel" });
    expect(reduceMenuKey(CTRL_C, 0, 3)).toEqual({ type: "cancel" });
  });

  it("ignores unrelated keys", () => {
    expect(reduceMenuKey("x", 0, 3)).toEqual({ type: "none" });
  });
});

describe("renderMenuFrame", () => {
  it("marks the selected row with the pointer and shows hints", () => {
    const frame = stripAnsi(renderMenuFrame("Pick one", OPTIONS, 0));
    expect(frame).toContain("Pick one");
    expect(frame).toContain("\u25B8 Setup");
    expect(frame).toContain("Connect Dosu to your AI agents");
    expect(frame).toContain("Authenticate");
    expect(frame).toContain("\u2191\u2193 move");
  });

  it("moves the pointer with the selection", () => {
    const frame = stripAnsi(renderMenuFrame("Pick one", OPTIONS, 2));
    expect(frame).toContain("\u25B8 Exit");
    expect(frame).not.toContain("\u25B8 Setup");
  });

  it("anchors the block to the content column's left edge (no self-centering)", () => {
    const frame = stripAnsi(renderMenuFrame("Pick one", OPTIONS, 0));
    expect(frame.split("\n")[0]).toBe("Pick one");
  });
});

// ---------------------------------------------------------------------------
// menuSelect — driven through fake streams
// ---------------------------------------------------------------------------

interface FakeInput extends EventEmitter {
  isTTY: boolean;
  isRaw?: boolean;
  setRawMode: (raw: boolean) => void;
  resume: () => void;
  pause: () => void;
}

function fakeIO(inputOverrides: Partial<FakeInput> = {}) {
  const input = Object.assign(new EventEmitter(), {
    isTTY: true,
    isRaw: false,
    setRawMode(raw: boolean) {
      this.isRaw = raw;
    },
    resume() {},
    pause() {},
    ...inputOverrides,
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

  return { input, output, written };
}

describe("menuSelect", () => {
  it("resolves the highlighted value on enter", async () => {
    const { input, output, written } = fakeIO();
    const result = menuSelect("Pick one", OPTIONS, { input, output });
    input.emit("data", DOWN);
    input.emit("data", "\r");
    await expect(result).resolves.toBe("auth");
    // The menu erases itself without leaving an echo — the launched flow
    // renders its own header, so an echo line would duplicate it.
    expect(stripAnsi(written.join(""))).not.toContain("\u2714");
  });

  it("jump-selects with a number key", async () => {
    const { input, output } = fakeIO();
    const result = menuSelect("Pick one", OPTIONS, { input, output });
    input.emit("data", "3");
    await expect(result).resolves.toBe("exit");
  });

  it("resolves null on cancel and leaves no echo", async () => {
    const { input, output, written } = fakeIO();
    const result = menuSelect("Pick one", OPTIONS, { input, output });
    input.emit("data", "q");
    await expect(result).resolves.toBeNull();
    expect(stripAnsi(written.join(""))).not.toContain("\u2714");
  });

  it("restores raw mode after finishing", async () => {
    const { input, output } = fakeIO();
    const result = menuSelect("Pick one", OPTIONS, { input, output });
    expect((input as unknown as FakeInput).isRaw).toBe(true);
    input.emit("data", "\r");
    await result;
    expect((input as unknown as FakeInput).isRaw).toBe(false);
  });

  it("resolves null immediately for non-interactive stdin", async () => {
    const { input, output, written } = fakeIO({ isTTY: false });
    await expect(menuSelect("Pick one", OPTIONS, { input, output })).resolves.toBeNull();
    expect(written).toEqual([]);
  });

  it("live-refreshes the frame when the polled options change", async () => {
    vi.useFakeTimers();
    try {
      const { input, output, written } = fakeIO();
      let mining = true;
      const buildOptions = () => [
        { label: mining ? "Activity (mining)" : "Activity", value: "sync" },
        { label: "Exit", value: "exit" },
      ];
      const redrawScreen = vi.fn();
      const result = menuSelect("Pick one", buildOptions(), {
        input,
        output,
        refresh: { intervalMs: 100, options: buildOptions, redrawScreen },
      });

      // Same options → no repaint, no screen redraw.
      vi.advanceTimersByTime(250);
      expect(redrawScreen).not.toHaveBeenCalled();

      // Mining ends → the next poll repaints banner + menu with fresh rows.
      mining = false;
      input.emit("data", DOWN); // move to Exit first: selection must survive
      vi.advanceTimersByTime(150);
      expect(redrawScreen).toHaveBeenCalledTimes(1);
      const text = stripAnsi(written.join(""));
      expect(text).toContain("Activity (mining)");
      expect(text.split("Activity\n").length).toBeGreaterThan(1);

      // Selection survived the repaint; the timer dies with the menu.
      input.emit("data", "\r");
      await expect(result).resolves.toBe("exit");
      vi.advanceTimersByTime(500);
      expect(redrawScreen).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
  });
});
