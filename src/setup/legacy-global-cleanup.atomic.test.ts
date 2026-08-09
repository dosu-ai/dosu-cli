import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mockAtomicWrite = vi.hoisted(() => vi.fn());

vi.mock("write-file-atomic", () => ({
  default: { sync: mockAtomicWrite },
}));

import { cleanupLegacyGlobalRule } from "./legacy-global-cleanup";

describe("legacy global rule cleanup atomicity", () => {
  let tempDir: string;
  let originalCodexHome: string | undefined;

  beforeEach(() => {
    tempDir = realpathSync(mkdtempSync(join(tmpdir(), "dosu-legacy-rule-atomic-")));
    originalCodexHome = process.env.CODEX_HOME;
    process.env.CODEX_HOME = tempDir;
    mockAtomicWrite.mockReset();
  });

  afterEach(() => {
    if (originalCodexHome === undefined) delete process.env.CODEX_HOME;
    else process.env.CODEX_HOME = originalCodexHome;
    rmSync(tempDir, { recursive: true, force: true });
    vi.restoreAllMocks();
  });

  it("keeps the original file when the atomic replacement fails", () => {
    const path = join(tempDir, "AGENTS.md");
    const original =
      "# User instructions\n\n<!-- dosu:rules:start v1 -->\nlegacy\n<!-- dosu:rules:end -->\n";
    mkdirSync(tempDir, { recursive: true });
    writeFileSync(path, original, "utf-8");
    mockAtomicWrite.mockImplementation(() => {
      throw new Error("disk full");
    });

    expect(() => cleanupLegacyGlobalRule("codex")).not.toThrow();
    expect(readFileSync(path, "utf-8")).toBe(original);
    expect(mockAtomicWrite).toHaveBeenCalledOnce();
  });
});
