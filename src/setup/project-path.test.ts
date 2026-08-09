import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { assertSafeProjectPath } from "./project-path";

let root: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "dosu-safe-project-path-"));
});

afterEach(() => rmSync(root, { recursive: true, force: true }));

describe("assertSafeProjectPath", () => {
  it("accepts existing and not-yet-created paths under the project", () => {
    mkdirSync(join(root, ".cursor"));
    writeFileSync(join(root, ".cursor", "mcp.json"), "{}");

    expect(() => assertSafeProjectPath(root, join(root, ".cursor", "mcp.json"))).not.toThrow();
    expect(() => assertSafeProjectPath(root, join(root, ".codex", "config.toml"))).not.toThrow();
  });

  it("rejects a lexical escape and a symlinked parent directory", () => {
    const outside = mkdtempSync(join(tmpdir(), "dosu-safe-project-outside-"));
    try {
      symlinkSync(outside, join(root, ".cursor"));
      expect(() => assertSafeProjectPath(root, join(root, "..", "outside.json"))).toThrow(
        /escapes/i,
      );
      expect(() => assertSafeProjectPath(root, join(root, ".cursor", "mcp.json"))).toThrow(
        /symbolic link/i,
      );
    } finally {
      rmSync(outside, { recursive: true, force: true });
    }
  });

  it("rejects dangling target and parent symlinks without creating their outside targets", () => {
    const outsideFile = join(root, "..", `outside-${process.pid}.json`);
    const outsideDirectory = join(root, "..", `outside-dir-${process.pid}`);
    symlinkSync(outsideFile, join(root, "AGENTS.md"));
    symlinkSync(outsideDirectory, join(root, ".cursor"));

    expect(() => assertSafeProjectPath(root, join(root, "AGENTS.md"))).toThrow(/symbolic link/i);
    expect(() => assertSafeProjectPath(root, join(root, ".cursor", "mcp.json"))).toThrow(
      /symbolic link/i,
    );
  });
});
