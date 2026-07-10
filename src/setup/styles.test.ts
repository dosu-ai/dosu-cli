import { describe, expect, it, vi } from "vitest";
import {
  bold,
  browserFallbackHint,
  dim,
  error,
  IconAdd,
  IconError,
  IconQuestion,
  IconRemove,
  IconSuccess,
  IconWarning,
  info,
  printBox,
  printError,
  printSuccess,
  printWarning,
  question,
  success,
  warning,
} from "./styles";

describe("styles", () => {
  describe("icons", () => {
    it("defines expected unicode icons", () => {
      expect(IconSuccess).toBe("\u2714");
      expect(IconError).toBe("\u2716");
      expect(IconWarning).toBe("\u26A0");
      expect(IconQuestion).toBe("?");
      expect(IconAdd).toBe("+");
      expect(IconRemove).toBe("-");
    });
  });

  describe("formatters", () => {
    it("success includes checkmark", () => {
      expect(success("done")).toContain("done");
      expect(success("done")).toContain(IconSuccess);
    });

    it("error includes cross", () => {
      expect(error("fail")).toContain("fail");
      expect(error("fail")).toContain(IconError);
    });

    it("warning includes warning icon", () => {
      expect(warning("warn")).toContain("warn");
    });

    it("question includes question mark", () => {
      expect(question("ask")).toContain("ask");
      expect(question("ask")).toContain(IconQuestion);
    });

    it("dim returns a string", () => {
      expect(typeof dim("text")).toBe("string");
    });

    it("bold returns a string", () => {
      expect(typeof bold("text")).toBe("string");
    });

    it("info returns a string", () => {
      expect(typeof info("text")).toBe("string");
    });

    it("browserFallbackHint puts the URL on its own line", () => {
      const hint = browserFallbackHint("https://example.com/auth?x=1");
      expect(hint).toContain("If your browser doesn't open automatically, visit:\n");
      expect(hint).toContain("https://example.com/auth?x=1");
    });
  });

  describe("print functions", () => {
    it("printSuccess calls console.log", () => {
      const spy = vi.spyOn(console, "log").mockImplementation(() => {});
      printSuccess("test");
      expect(spy).toHaveBeenCalledOnce();
      spy.mockRestore();
    });

    it("printError calls console.log", () => {
      const spy = vi.spyOn(console, "log").mockImplementation(() => {});
      printError("test");
      expect(spy).toHaveBeenCalledOnce();
      spy.mockRestore();
    });

    it("printWarning calls console.log", () => {
      const spy = vi.spyOn(console, "log").mockImplementation(() => {});
      printWarning("test");
      expect(spy).toHaveBeenCalledOnce();
      spy.mockRestore();
    });

    it("printBox prints border and lines", () => {
      const spy = vi.spyOn(console, "log").mockImplementation(() => {});
      printBox("line1", "line2");
      // border + 2 lines + border = 4 calls
      expect(spy).toHaveBeenCalledTimes(4);
      spy.mockRestore();
    });
  });
});
