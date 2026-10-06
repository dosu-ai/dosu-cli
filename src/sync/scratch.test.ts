import { describe, expect, it } from "vitest";
import { isScratchDir } from "./scratch";

describe("isScratchDir", () => {
  it.each([
    "/tmp/repro",
    "/private/tmp/claude-501/scratchpad",
    "/var/folders/3m/abc/T/replay-claude--pr12296-mid--r0-swo3o1x8",
    "/private/var/folders/3m/abc/T/replay",
  ])("treats %s as scratch", (dir) => {
    expect(isScratchDir(dir)).toBe(true);
  });

  it("follows the OS temp dir wherever it lives", () => {
    expect(isScratchDir("/custom/tmp/run-1", "/custom/tmp")).toBe(true);
  });

  it.each([
    "/Users/me/dosu",
    "/home/me/tmpl",
    "/tmpfiles/x",
    "/srv/var/folders-not",
  ])("keeps %s", (dir) => {
    expect(isScratchDir(dir, "/custom/tmp")).toBe(false);
  });
});
