import { describe, it, expect } from "vitest";
import { mkdtempSync, rmSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { isInstalled, expandHome, appSupportDir } from "./detect";

describe("detect", () => {
  describe("expandHome", () => {
    it("expands ~ to home directory", () => {
      const result = expandHome("~/.config");
      expect(result).not.toContain("~");
      expect(result).toContain(".config");
    });

    it("returns path unchanged if not starting with ~", () => {
      expect(expandHome("/usr/local/bin")).toBe("/usr/local/bin");
    });

    it("returns empty string unchanged", () => {
      expect(expandHome("")).toBe("");
    });
  });

  describe("isInstalled", () => {
    let tempDir: string;

    it("returns true if any path exists", () => {
      tempDir = mkdtempSync(join(tmpdir(), "dosu-detect-"));
      const existingPath = join(tempDir, "exists");
      mkdirSync(existingPath);
      expect(isInstalled(["/nonexistent/path", existingPath])).toBe(true);
      rmSync(tempDir, { recursive: true, force: true });
    });

    it("returns false if no paths exist", () => {
      expect(isInstalled(["/nonexistent/path1", "/nonexistent/path2"])).toBe(false);
    });

    it("returns false for empty array", () => {
      expect(isInstalled([])).toBe(false);
    });
  });

  describe("appSupportDir", () => {
    it("returns a non-empty string", () => {
      expect(appSupportDir().length).toBeGreaterThan(0);
    });
  });
});
