import { EventEmitter } from "node:events";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { confirm, intro, isCancel, log, multiselect, outro, select, spinner } from "./prompts";

const ESC = String.fromCharCode(27);
const UP = `${ESC}[A`;
const DOWN = `${ESC}[B`;
const LEFT = `${ESC}[D`;
const CTRL_C = String.fromCharCode(3);

function stripAnsi(text: string): string {
  return text.replace(new RegExp(`${ESC}\\[[0-9;?]*[A-Za-z]`, "g"), "");
}

function fakeIO(overrides: { inputTTY?: boolean; outputTTY?: boolean; rows?: number } = {}) {
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
    isTTY: overrides.outputTTY ?? true,
    columns: 80,
    rows: overrides.rows ?? 24,
    write(chunk: string) {
      written.push(chunk);
      return true;
    },
  } as unknown as NodeJS.WriteStream;

  const text = () => stripAnsi(written.join(""));
  return { input, output, written, text };
}

describe("intro / outro / log", () => {
  it("intro opens and outro closes the flow with a framing rule", () => {
    const { output, text } = fakeIO();
    intro("dosu setup", { output });
    outro("done", { output });
    const rule = "\u2500".repeat(64);
    expect(text()).toBe(`\ndosu setup\n${rule}\n\n\n${rule}\ndone\n\n`);
  });

  it("log levels use distinct markers", () => {
    const { output, text } = fakeIO();
    log.success("ok", { output });
    log.error("bad", { output });
    log.warn("careful", { output });
    log.info("fyi", { output });
    expect(text()).toContain("\u2714 ok");
    expect(text()).toContain("\u2716 bad");
    expect(text()).toContain("! careful");
    expect(text()).toContain("\u00B7 fyi");
  });

  it("indents continuation lines under the marker", () => {
    const { output, text } = fakeIO();
    log.success("API key\ncreated", { output });
    expect(text()).toBe("\u2714 API key\n  created\n");
  });
});

describe("spinner", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("animates frames on a TTY and collapses to a check on stop", () => {
    const { output, text } = fakeIO();
    const s = spinner({ output });
    s.start("Working");
    vi.advanceTimersByTime(200);
    s.stop("Worked");
    expect(text()).toContain("Working");
    expect(text()).toContain("\u2714 Worked");
  });

  it("stops with the last message when none is given, honoring message()", () => {
    const { output, text } = fakeIO();
    const s = spinner({ output });
    s.start("first");
    s.message("second");
    s.stop();
    expect(text()).toContain("\u2714 second");
  });

  it("uses an error marker for nonzero stop codes", () => {
    const { output, text } = fakeIO();
    const s = spinner({ output });
    s.start("try");
    s.stop("failed", 1);
    expect(text()).toContain("\u2716 failed");
  });

  it("prints plain lines without animation when not a TTY", () => {
    const { output, text, written } = fakeIO({ outputTTY: false });
    const s = spinner({ output });
    s.start("quiet");
    vi.advanceTimersByTime(500);
    const during = written.length;
    s.stop("done");
    expect(written.length).toBe(during + 1);
    expect(text()).toBe("\u00B7 quiet\n\u2714 done\n");
  });
});

describe("select", () => {
  const OPTIONS = [
    { value: "a", label: "Alpha", hint: "first" },
    { value: "b", label: "Beta" },
  ];

  it("resolves the highlighted value and echoes the answer", async () => {
    const { input, output, text } = fakeIO();
    const result = select({ message: "Pick", options: OPTIONS }, { input, output });
    input.emit("data", DOWN);
    input.emit("data", "\r");
    await expect(result).resolves.toBe("b");
    expect(text()).toContain("\u2714 Pick \u00B7 Beta");
  });

  it("renders hints and the key legend", async () => {
    const { input, output, text } = fakeIO();
    const result = select({ message: "Pick", options: OPTIONS }, { input, output });
    expect(text()).toContain("first");
    expect(text()).toContain("\u2191\u2193 move");
    input.emit("data", CTRL_C);
    await expect(result.then(isCancel)).resolves.toBe(true);
  });

  it("marks every frame line with the brand bar while active", async () => {
    const { input, output, text } = fakeIO();
    const result = select({ message: "Pick", options: OPTIONS }, { input, output });
    const frameLines = text()
      .split("\n")
      .filter((line) => line.trim() !== "" || line.startsWith("\u258C"));
    expect(frameLines.length).toBeGreaterThan(0);
    for (const line of frameLines) expect(line.startsWith("\u258C")).toBe(true);
    input.emit("data", "\r");
    // The bar vanishes from the collapsed echo once the step commits.
    await result;
    const echo = text().split("\n").at(-2) ?? "";
    expect(echo).toContain("\u2714 Pick");
    expect(echo).not.toContain("\u258C");
  });

  it("falls back to the stringified value when label is omitted", async () => {
    const { input, output, text } = fakeIO();
    const result = select({ message: "Pick", options: [{ value: "raw" }] }, { input, output });
    input.emit("data", "\r");
    await expect(result).resolves.toBe("raw");
    expect(text()).toContain("raw");
  });

  it("cancels for non-interactive stdin", async () => {
    const { input, output } = fakeIO({ inputTTY: false });
    const result = await select({ message: "Pick", options: OPTIONS }, { input, output });
    expect(isCancel(result)).toBe(true);
  });
});

describe("multiselect", () => {
  const OPTIONS = [
    { value: "one", label: "One" },
    { value: "two", label: "Two", hint: "already on" },
    { value: "three", label: "Three" },
  ];

  it("keeps initial values and toggles with space", async () => {
    const { input, output, text } = fakeIO();
    const result = multiselect(
      { message: "Choose", options: OPTIONS, initialValues: ["two"] },
      { input, output },
    );
    input.emit("data", " "); // tick One
    input.emit("data", DOWN);
    input.emit("data", " "); // untick Two
    input.emit("data", "\r");
    await expect(result).resolves.toEqual(["one"]);
    expect(text()).toContain("\u2714 Choose \u00B7 One");
  });

  it("counts the picks once they no longer fit on a line", async () => {
    const manyOptions = ["a", "b", "c", "d"].map((value) => ({ value, label: value }));
    const { input, output, text } = fakeIO();
    const result = multiselect(
      { message: "Choose", options: manyOptions, initialValues: ["a", "b", "c", "d"] },
      { input, output },
    );
    input.emit("data", "\r");
    await expect(result).resolves.toEqual(["a", "b", "c", "d"]);
    expect(text()).toContain("\u2714 Choose \u00B7 4 selected");
  });

  it("echoes 'none' for an empty confirmed selection", async () => {
    const { input, output, text } = fakeIO();
    const result = multiselect({ message: "Choose", options: OPTIONS }, { input, output });
    input.emit("data", "\r");
    await expect(result).resolves.toEqual([]);
    expect(text()).toContain("\u2714 Choose \u00B7 none");
  });

  it("allows submitting an empty selection", async () => {
    const { input, output } = fakeIO();
    const result = multiselect({ message: "Choose", options: OPTIONS }, { input, output });
    input.emit("data", "\r");
    await expect(result).resolves.toEqual([]);
  });

  it("wraps the cursor and cancels on esc", async () => {
    const { input, output } = fakeIO();
    const result = multiselect({ message: "Choose", options: OPTIONS }, { input, output });
    input.emit("data", UP); // wraps to last row
    input.emit("data", " ");
    input.emit("data", ESC);
    const value = await result;
    expect(isCancel(value)).toBe(true);
  });

  it("statusFor replaces static hints and reacts to toggling", async () => {
    const { input, output, text } = fakeIO();
    const result = multiselect(
      {
        message: "Choose",
        options: OPTIONS,
        initialValues: ["two"],
        statusFor: (value, picked) => {
          if (value === "two") return picked ? "kept" : "dropped";
          return picked ? "added" : undefined;
        },
      },
      { input, output },
    );
    // Static hint is superseded by the live status.
    expect(text()).not.toContain("already on");
    expect(text()).toContain("kept");
    input.emit("data", DOWN);
    input.emit("data", " "); // untick Two
    expect(text()).toContain("dropped");
    input.emit("data", ESC);
    expect(isCancel(await result)).toBe(true);
  });

  it("validate blocks confirm with a warning until the picks change", async () => {
    const { input, output, text, written } = fakeIO();
    const result = multiselect(
      {
        message: "Choose",
        options: OPTIONS,
        validate: (picked) => (picked.length === 0 ? "Pick at least one." : undefined),
      },
      { input, output },
    );
    input.emit("data", "\r"); // blocked: nothing picked
    expect(text()).toContain("Pick at least one.");
    input.emit("data", " "); // ticking clears the warning
    const framesAfterToggle = written.length;
    input.emit("data", "\r");
    await expect(result).resolves.toEqual(["one"]);
    expect(written.slice(framesAfterToggle).join("")).not.toContain("Pick at least one.");
  });

  it("windows long lists to the terminal height and follows the cursor", async () => {
    const many = Array.from({ length: 10 }, (_, i) => ({ value: `v${i}`, label: `Option ${i}` }));
    // rows=13 → 4 visible option rows.
    const { input, output, written } = fakeIO({ rows: 13 });
    const result = multiselect({ message: "Choose", options: many }, { input, output });

    const first = stripAnsi(written.join(""));
    expect(first).toContain("Option 0");
    expect(first).toContain("Option 3");
    expect(first).not.toContain("Option 4");
    expect(first).toContain("\u2193 6 more");
    expect(first).not.toMatch(/\u2191 \d+ more/);

    for (let i = 0; i < 5; i++) input.emit("data", DOWN); // cursor → Option 5
    const scrolled = stripAnsi(written.at(-1) ?? "");
    expect(scrolled).toContain("Option 5");
    expect(scrolled).not.toContain("Option 1 ");
    expect(scrolled).toContain("\u2191 2 more");
    expect(scrolled).toContain("\u2193 4 more");

    input.emit("data", ESC);
    expect(isCancel(await result)).toBe(true);
  });

  it("clips overlong labels to the content width, keeping the tail", async () => {
    const longPath = `/private/var/folders/ab/xyz/T/some-extremely-long-temp-folder-name-here`;
    const { input, output, text } = fakeIO();
    const result = multiselect(
      { message: "Choose", options: [{ value: longPath }] },
      { input, output },
    );
    expect(text()).not.toContain(longPath);
    expect(text()).toContain("\u2026");
    expect(text()).toContain("some-extremely-long-temp-folder-name-here");
    input.emit("data", ESC);
    expect(isCancel(await result)).toBe(true);
  });

  it("'a' toggles between all and none", async () => {
    const { input, output } = fakeIO();
    const result = multiselect(
      { message: "Choose", options: OPTIONS, initialValues: ["two"] },
      { input, output },
    );
    input.emit("data", "a"); // partial → all
    input.emit("data", "a"); // all → none
    input.emit("data", " "); // tick just One
    input.emit("data", "\r");
    await expect(result).resolves.toEqual(["one"]);
  });

  it("renders a live summary line above the legend", async () => {
    const { input, output, written, text } = fakeIO();
    const result = multiselect(
      {
        message: "Choose",
        options: OPTIONS,
        summary: (picked) => (picked.length > 0 ? `${picked.length} picked` : "no changes"),
      },
      { input, output },
    );
    expect(text()).toContain("no changes");
    input.emit("data", " "); // tick One
    expect(written.join("")).toContain("1 picked");
    input.emit("data", "\r");
    await expect(result).resolves.toEqual(["one"]);
  });
});

describe("confirm", () => {
  it("defaults to Yes on enter", async () => {
    const { input, output, text } = fakeIO();
    const result = confirm({ message: "Proceed?" }, { input, output });
    input.emit("data", "\r");
    await expect(result).resolves.toBe(true);
    expect(text()).toContain("\u2714 Proceed? \u00B7 Yes");
  });

  it("toggles with arrows and resolves No", async () => {
    const { input, output } = fakeIO();
    const result = confirm({ message: "Proceed?" }, { input, output });
    input.emit("data", LEFT);
    input.emit("data", "\r");
    await expect(result).resolves.toBe(false);
  });

  it("answers instantly with y and n shortcuts", async () => {
    const a = fakeIO();
    const first = confirm({ message: "Proceed?" }, { input: a.input, output: a.output });
    a.input.emit("data", "n");
    await expect(first).resolves.toBe(false);

    const b = fakeIO();
    const second = confirm({ message: "Proceed?" }, { input: b.input, output: b.output });
    b.input.emit("data", "y");
    await expect(second).resolves.toBe(true);
  });

  it("cancels on q", async () => {
    const { input, output } = fakeIO();
    const result = confirm({ message: "Proceed?" }, { input, output });
    input.emit("data", "q");
    expect(isCancel(await result)).toBe(true);
  });
});
