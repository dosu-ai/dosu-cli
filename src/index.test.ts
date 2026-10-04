import { describe, expect, it, vi } from "vitest";

vi.mock("./cli/cli", () => ({
  execute: vi.fn().mockResolvedValue(undefined),
}));
vi.mock("./memory/two-stage", () => ({
  pollFullRecall: vi.fn().mockResolvedValue(null),
}));

describe("CLI entry point", () => {
  it("registers a SIGINT handler that calls process.exit(0)", async () => {
    const mockExit = vi.spyOn(process, "exit").mockImplementation(() => undefined as never);

    // Import triggers module-level side effects (SIGINT handler registration)
    await import("./index");

    // Simulate SIGINT by emitting the event
    process.emit("SIGINT");

    expect(mockExit).toHaveBeenCalledWith(0);
    mockExit.mockRestore();
  });

  it("runs stage two's poller without Commander, whose preAction runs the update check", async () => {
    const argv = process.argv;
    process.argv = [argv[0], "dosu", "memory", "recall-poll", "--session", "s-1"];
    try {
      vi.resetModules();
      vi.clearAllMocks();
      await import("./index");
      const { pollFullRecall } = await import("./memory/two-stage");
      const { execute } = await import("./cli/cli");

      await vi.waitFor(() => expect(pollFullRecall).toHaveBeenCalledWith("s-1"));
      expect(execute).not.toHaveBeenCalled();
    } finally {
      process.argv = argv;
    }
  });
});
