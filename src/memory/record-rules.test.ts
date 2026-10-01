import { describe, expect, it } from "vitest";
import { clip, parseCommandObservation, prepareRecordedCommand } from "./record-rules";

// Expected values come from running the frozen Python (coding-memory-bench 0951e6a) on the same
// inputs; the server renders records from these, so they must match byte for byte.

const observe = (rc: number, output: string) =>
  parseCommandObservation(`<returncode>${rc}</returncode>\n<output>\n${output}\n</output>`);

describe("prepareRecordedCommand", () => {
  it.each([
    ["cd /w && cat > a.py <<'EOF'\nprint(1)\nEOF\npython a.py", "cat > a.py <<'EOF'\npython a.py"],
    ["cd /repo   &&   pytest -q   tests/", "pytest -q tests/"],
    ['cat <<-  "END"\n\tbody\n\tEND\necho done', 'cat <<- "END"\necho done'],
    ["echo '<<NOT' && cat <<A <<B\na\nA\nb\nB\nls", "echo '<<NOT' && cat <<A <<B\nls"],
    ['git commit -m "x <<EOF"\nls', 'git commit -m "x <<EOF"\nls'],
    // Faithful quirk: the scanner reads the inner "<< here" of a here-string as a heredoc.
    ["cat <<< here\nnext", "cat <<< here"],
    ["  \n\n  ls   -la  \n\t\n", "ls -la"],
    ["cd a && cd b && make", "cd b && make"],
    ["cat <<EOF\nunterminated\nbody", "cat <<EOF"],
    ["x\r\ny\rz", "x\ny\nz"],
  ])("cleans %j", (command, expected) => {
    expect(prepareRecordedCommand(command)).toBe(expected);
  });
});

describe("parseCommandObservation", () => {
  it("has no error line for a zero return code", () => {
    expect(observe(0, "ERROR: ignored on success")).toEqual([0, null]);
  });

  it("keeps the last matching line, not the first", () => {
    expect(observe(1, "foo\nERROR: first\nsomething\nerror: second\n")).toEqual([
      1,
      "error: second",
    ]);
  });

  it("strips ANSI codes and skips lines that open with a colon or quote", () => {
    const output = "\x1b[31mFAILED\x1b[0m tests/test_x.py::t - assert 1\n: error: no\n'error: no'";
    expect(observe(2, output)).toEqual([2, "FAILED tests/test_x.py::t - assert 1"]);
  });

  it("splits on carriage returns and collapses whitespace like Python", () => {
    expect(observe(1, "progress 10%\rERROR: carriage\nfine")).toEqual([1, "ERROR: carriage"]);
    expect(observe(1, "   \n\t  ERROR:    spaced    out   \n")).toEqual([1, "ERROR: spaced out"]);
  });

  it("cuts long lines to 157 code points plus an ellipsis", () => {
    expect(observe(1, `${"a".repeat(300)} error: long`)).toEqual([1, `${"a".repeat(157)}...`]);
    expect(observe(2, `${"😀".repeat(200)} ERROR`)).toEqual([2, `${"😀".repeat(157)}...`]);
  });

  it("returns null without a return code and no line without a marker", () => {
    expect(parseCommandObservation("no code")).toBeNull();
    expect(observe(127, "bash: foo: command not found")).toEqual([
      127,
      "bash: foo: command not found",
    ]);
    expect(observe(1, "nothing to see")).toEqual([1, null]);
  });
});

describe("clip", () => {
  it("strips and keeps both ends around a cut marker, counting code points", () => {
    expect(clip("  hello  ", 4000)).toBe("hello");
    expect(clip("x".repeat(10), 4)).toBe("xx\n[... 6 characters cut ...]\nxx");
    expect(clip(`${"😀".repeat(10)}abc`, 6)).toBe("😀😀😀\n[... 7 characters cut ...]\nabc");
  });
});
