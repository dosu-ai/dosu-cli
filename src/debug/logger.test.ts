import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { logger } from "./logger";

let tempDir: string;
let origXDG: string | undefined;

beforeEach(() => {
  tempDir = mkdtempSync(join(tmpdir(), "dosu-logger-test-"));
  origXDG = process.env.XDG_CONFIG_HOME;
  process.env.XDG_CONFIG_HOME = tempDir;
  logger._resetForTesting();
});

afterEach(() => {
  if (origXDG !== undefined) process.env.XDG_CONFIG_HOME = origXDG;
  else delete process.env.XDG_CONFIG_HOME;
  rmSync(tempDir, { recursive: true, force: true });
  logger._resetForTesting();
});

function logPath(): string {
  return join(tempDir, "dosu-cli", "debug.log");
}

describe("logger", () => {
  describe("getLogPath", () => {
    it("returns path ending with dosu-cli/debug.log", () => {
      const p = logger.getLogPath();
      expect(p).toBe(logPath());
    });
  });

  describe("writing", () => {
    it("writes log entries to file", () => {
      logger.info("test", "hello world");
      const content = readFileSync(logPath(), "utf-8");
      expect(content).toContain("hello world");
    });

    it("formats entries as [timestamp] [LEVEL] [module] message", () => {
      logger.info("mymod", "test message");
      const content = readFileSync(logPath(), "utf-8");
      const match = content.match(
        /\[\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}.\d{3}Z\] \[INFO\] \[mymod\] test message/,
      );
      expect(match).not.toBeNull();
    });

    it("supports all four log levels", () => {
      logger.debug("m", "d");
      logger.info("m", "i");
      logger.warn("m", "w");
      logger.error("m", "e");

      const content = readFileSync(logPath(), "utf-8");
      expect(content).toContain("[DEBUG]");
      expect(content).toContain("[INFO]");
      expect(content).toContain("[WARN]");
      expect(content).toContain("[ERROR]");
    });
  });

  describe("session header", () => {
    it("writes session header on init", () => {
      logger.init({});
      const content = readFileSync(logPath(), "utf-8");
      expect(content).toContain("Session:");
      expect(content).toContain(process.platform);
      expect(content).toContain(process.arch);
      expect(content).toContain("════");
    });
  });

  describe("size control", () => {
    it("truncates log file when it exceeds 1MB", () => {
      // Write >1MB of data
      const bigLine = `${"X".repeat(200)}\n`;
      const chunk = bigLine.repeat(6000); // ~1.2MB
      const dir = join(tempDir, "dosu-cli");
      const { mkdirSync } = require("node:fs");
      mkdirSync(dir, { recursive: true });
      writeFileSync(logPath(), chunk);

      // Re-init triggers truncation
      logger._resetForTesting();
      logger.init({});

      const content = readFileSync(logPath(), "utf-8");
      // File should be smaller than original but contain the session header
      expect(content.length).toBeLessThan(chunk.length);
      expect(content.length).toBeGreaterThan(0);
      expect(content).toContain("Session:");
    });

    it("does not truncate when file is under 1MB", () => {
      logger.init({});
      logger.info("test", "small entry");

      logger._resetForTesting();
      logger.init({});
      const content = readFileSync(logPath(), "utf-8");

      // Original entry preserved, plus a second session header appended
      expect(content).toContain("small entry");
      // Two session headers (one from each init)
      const sessionCount = (content.match(/Session:/g) ?? []).length;
      expect(sessionCount).toBe(2);
    });
  });

  describe("debug console output", () => {
    it("outputs to stderr when debug is enabled", () => {
      const spy = vi.spyOn(console, "error").mockImplementation(() => {});
      logger.init({ debug: true });
      logger.info("test", "visible");
      expect(spy).toHaveBeenCalledWith(expect.stringContaining("visible"));
      spy.mockRestore();
    });

    it("does not output to stderr when debug is disabled", () => {
      const spy = vi.spyOn(console, "error").mockImplementation(() => {});
      logger.init({ debug: false });
      logger.info("test", "invisible");
      // spy should only be called for the session header, not for log entries
      // Actually, console.error is only called by writeEntry, not writeSessionHeader
      // So check that none of the calls contain "invisible"
      const calls = spy.mock.calls.map((c) => c.join(" "));
      expect(calls.every((c) => !c.includes("invisible"))).toBe(true);
      spy.mockRestore();
    });
  });

  describe("graceful degradation", () => {
    it("does not throw when log path is unwritable", () => {
      // Point to a path that can't be created
      process.env.XDG_CONFIG_HOME = "/proc/nonexistent";
      logger._resetForTesting();

      expect(() => logger.info("test", "should not crash")).not.toThrow();
    });
  });

  describe("lazy init", () => {
    it("creates log file on first write without explicit init", () => {
      expect(existsSync(logPath())).toBe(false);
      logger.info("test", "lazy");
      expect(existsSync(logPath())).toBe(true);
      const content = readFileSync(logPath(), "utf-8");
      expect(content).toContain("lazy");
    });
  });
});
