import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { createRunConfigDir } from "./config-dir";

describe("createRunConfigDir", () => {
  it("creates a fresh dir seeded with completed onboarding", () => {
    const run = createRunConfigDir();
    try {
      const seeded = JSON.parse(readFileSync(join(run.path, ".claude.json"), "utf8"));
      expect(seeded).toEqual({ hasCompletedOnboarding: true });
    } finally {
      run.cleanup();
    }
  });

  it("cleanup removes the dir and is idempotent", () => {
    const run = createRunConfigDir();
    run.cleanup();
    expect(existsSync(run.path)).toBe(false);
    expect(() => run.cleanup()).not.toThrow();
  });

  it("returns a unique dir per run", () => {
    const a = createRunConfigDir();
    const b = createRunConfigDir();
    try {
      expect(a.path).not.toBe(b.path);
    } finally {
      a.cleanup();
      b.cleanup();
    }
  });
});
