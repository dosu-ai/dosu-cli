import { describe, expect, it, vi } from "vitest";
import { createScanProgress } from "./scan-progress";

describe("Drive scan progress", () => {
  it("rewrites every TTY update on the current line", () => {
    const write = vi.fn();
    const progress = createScanProgress({ isTTY: true, write });

    progress.start("Scanning local agent sessions on this Mac…");
    progress.update("Scanning… ~/.codex/session-a.jsonl");
    progress.update("Scanning… ~/.cursor/session-b.jsonl");
    progress.stop("Sessions found");

    expect(write.mock.calls.map(([chunk]) => chunk).join("")).toBe(
      [
        "◒  Scanning local agent sessions on this Mac…",
        "\r\x1b[2K◒  Scanning… ~/.codex/session-a.jsonl",
        "\r\x1b[2K◒  Scanning… ~/.cursor/session-b.jsonl",
        "\r\x1b[2K◇  Sessions found\n",
      ].join(""),
    );
    expect(write.mock.calls.slice(0, -1).every(([chunk]) => !String(chunk).includes("\n"))).toBe(
      true,
    );
  });

  it("keeps redirected output stable and omits path churn", () => {
    const write = vi.fn();
    const progress = createScanProgress({ isTTY: false, write });

    progress.start("Scanning local agent sessions on this Mac…");
    progress.update("Scanning… ~/.codex/session-a.jsonl");
    progress.stop("Sessions found");

    expect(write.mock.calls.map(([chunk]) => chunk)).toEqual([
      "Scanning local agent sessions on this Mac…\n",
      "◇  Sessions found\n",
    ]);
  });

  it("writes to stdout when no output is injected", () => {
    const write = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    try {
      createScanProgress().start("Scanning…");
      expect(write).toHaveBeenCalledWith("Scanning…\n");
    } finally {
      write.mockRestore();
    }
  });
});
