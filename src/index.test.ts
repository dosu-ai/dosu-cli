import { describe, expect, it, vi } from "vitest";

vi.mock("./cli/cli", () => ({
  execute: vi.fn().mockResolvedValue(undefined),
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
});
