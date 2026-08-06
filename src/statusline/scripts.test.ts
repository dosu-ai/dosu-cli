/**
 * Behavior tests for the embedded Python status-line renderer (spec contract).
 *
 * Runs the real script under python3 with fixture state and stdin and a temp
 * HOME, covering the render shapes and the fail-silent contract. Skipped when
 * python3 is not on PATH. The counting logic that populates the state lives in
 * TypeScript now — see state.test.ts.
 */

import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { STATUS_LINE_SOURCE } from "./assets";

const python3 = spawnSync("python3", ["--version"], { stdio: "ignore" }).status === 0;

let home: string;
let statuslinePath: string;

function stateDir(): string {
  return join(home, ".dosu", "statusline-state");
}

function statePath(sessionId: string): string {
  return join(stateDir(), `${sessionId}.knowledge.json`);
}

function run(stdin: string): { status: number | null; stdout: string } {
  const res = spawnSync("python3", [statuslinePath], {
    input: stdin,
    encoding: "utf8",
    env: { ...process.env, HOME: home },
  });
  return { status: res.status, stdout: res.stdout };
}

function writeState(state: Record<string, unknown>): void {
  mkdirSync(stateDir(), { recursive: true });
  writeFileSync(statePath("sess-1"), JSON.stringify(state));
}

const stdin = JSON.stringify({ session_id: "sess-1" });

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "dosu-statusline-py-"));
  statuslinePath = join(home, "dosu-statusline.py");
  writeFileSync(statuslinePath, STATUS_LINE_SOURCE);
});

afterEach(() => {
  rmSync(home, { recursive: true, force: true });
});

describe("embedded source constraints", () => {
  it("is ASCII-only and backtick-free", () => {
    // Bun's transpiler rewrites non-ASCII chars into JS \u{...} escapes even
    // inside String.raw, shipping the escape text instead of the character —
    // the emoji must live as Python \UXXXXXXXX escapes. Backticks would
    // terminate the template.
    // biome-ignore lint/suspicious/noControlCharactersInRegex: ASCII guard
    expect(STATUS_LINE_SOURCE).toMatch(/^[\x00-\x7f]*$/);
    expect(STATUS_LINE_SOURCE).not.toContain("`");
  });
});

describe.skipIf(!python3)("dosu-statusline.py", () => {
  it("renders pages and notes with plurals and dim label", () => {
    writeState({ pages: 3, notes: 77 });
    expect(run(stdin).stdout).toBe("\x1b[2mKnowledge\x1b[0m 📚 3 pages · 📝 77 notes\n");
  });

  it("uses singular forms for a count of one", () => {
    writeState({ pages: 1, notes: 1 });
    expect(run(stdin).stdout).toContain("📚 1 page · 📝 1 note");
  });

  it("omits notes when the delivery had none", () => {
    writeState({ pages: 3, notes: 0 });
    const out = run(stdin).stdout;
    expect(out).toContain("📚 3 pages");
    expect(out).not.toContain("📝");
  });

  it("renders notes only", () => {
    writeState({ pages: 0, notes: 12 });
    expect(run(stdin).stdout).toContain("📝 12 notes");
  });

  it("prints nothing when both counts are zero", () => {
    writeState({ pages: 0, notes: 0 });
    expect(run(stdin).stdout).toBe("");
  });

  it("prints nothing with no state file (pre-delivery: deliberately empty)", () => {
    const res = run(stdin);
    expect(res.status).toBe(0);
    expect(res.stdout).toBe("");
  });

  it("prints nothing on corrupt state JSON", () => {
    mkdirSync(stateDir(), { recursive: true });
    writeFileSync(statePath("sess-1"), "{corrupt");
    const res = run(stdin);
    expect(res.status).toBe(0);
    expect(res.stdout).toBe("");
  });

  it("prints nothing on garbage stdin", () => {
    const res = run("garbage");
    expect(res.status).toBe(0);
    expect(res.stdout).toBe("");
  });
});
