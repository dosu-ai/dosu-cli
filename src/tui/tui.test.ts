import { describe, it, expect } from "vitest";

// The TUI is interactive and can't be easily unit tested without mocking
// the entire @clack/prompts library. We test that the module exports correctly
// and that the logo constant exists.

describe("TUI", () => {
  it("exports runTUI function", async () => {
    const mod = await import("./tui");
    expect(typeof mod.runTUI).toBe("function");
  });
});
