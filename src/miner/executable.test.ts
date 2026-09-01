import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  binaryNames,
  findSystemClaude,
  resolveClaudeExecutable,
  sdkNativeBinaryExists,
} from "./executable";

let tempDir: string;

beforeEach(() => {
  tempDir = mkdtempSync(join(tmpdir(), "dosu-exec-test-"));
});

afterEach(() => {
  rmSync(tempDir, { recursive: true, force: true });
});

/** Create an executable stub file and return its path. */
function stubBinary(dir: string, name = "claude"): string {
  mkdirSync(dir, { recursive: true });
  const path = join(dir, name);
  writeFileSync(path, "#!/bin/sh\n");
  chmodSync(path, 0o755);
  return path;
}

describe("binaryNames", () => {
  it("returns claude for unix platforms", () => {
    expect(binaryNames("darwin")).toEqual(["claude"]);
    expect(binaryNames("linux")).toEqual(["claude"]);
  });

  it("returns exe and cmd shims for windows", () => {
    expect(binaryNames("win32")).toEqual(["claude.exe", "claude.cmd"]);
  });
});

describe("sdkNativeBinaryExists", () => {
  it("finds the platform binary in this repo's node_modules", () => {
    // The platform package is a devDependency of this repo, so from a source
    // checkout the SDK can always resolve its own binary.
    expect(sdkNativeBinaryExists()).toBe(true);
  });
});

describe("findSystemClaude", () => {
  it("finds an executable claude on PATH", () => {
    const binDir = join(tempDir, "bin");
    const expected = stubBinary(binDir);

    expect(findSystemClaude({ PATH: binDir }, tempDir)).toBe(expected);
  });

  it("skips non-executable files", () => {
    const binDir = join(tempDir, "bin");
    mkdirSync(binDir, { recursive: true });
    writeFileSync(join(binDir, "claude"), "");
    chmodSync(join(binDir, "claude"), 0o644);

    expect(findSystemClaude({ PATH: binDir }, tempDir)).toBeUndefined();
  });

  it("falls back to ~/.local/bin when PATH misses it", () => {
    const expected = stubBinary(join(tempDir, ".local", "bin"));

    expect(findSystemClaude({ PATH: join(tempDir, "empty") }, tempDir)).toBe(expected);
  });

  it("falls back to ~/.claude/local", () => {
    const expected = stubBinary(join(tempDir, ".claude", "local"));

    expect(findSystemClaude({ PATH: "" }, tempDir)).toBe(expected);
  });

  it("returns undefined when no install exists", () => {
    expect(findSystemClaude({ PATH: join(tempDir, "nope") }, tempDir)).toBeUndefined();
  });

  it("handles a missing PATH variable", () => {
    expect(findSystemClaude({}, tempDir)).toBeUndefined();
  });
});

describe("resolveClaudeExecutable", () => {
  it("returns undefined when the SDK has its own binary", () => {
    const result = resolveClaudeExecutable({
      sdkBinaryExists: () => true,
      env: { PATH: tempDir },
      homeDir: tempDir,
    });

    expect(result).toBeUndefined();
  });

  it("falls back to a system claude when the SDK binary is missing", () => {
    const binDir = join(tempDir, "bin");
    const expected = stubBinary(binDir);

    const result = resolveClaudeExecutable({
      sdkBinaryExists: () => false,
      env: { PATH: binDir },
      homeDir: tempDir,
    });

    expect(result).toBe(expected);
  });

  it("returns undefined when nothing is available anywhere", () => {
    const result = resolveClaudeExecutable({
      sdkBinaryExists: () => false,
      env: { PATH: "" },
      homeDir: tempDir,
    });

    expect(result).toBeUndefined();
  });
});
