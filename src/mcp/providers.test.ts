import { describe, expect, it } from "vitest";
import { allProviders, allSetupProviders, getProvider } from "./providers";

describe("provider registry", () => {
  it("allProviders returns the 8 agents whose sessions can be learned from, plus manual", () => {
    expect(allProviders().map((p) => p.id())).toEqual([
      "claude",
      "cursor",
      "gemini",
      "codex",
      "copilot",
      "opencode",
      "factory",
      "pi",
      "manual",
    ]);
  });

  // Agents without a @letta-ai/trajectory adapter get no provider: all the CLI could do for them
  // is write an MCP entry that never learns from their sessions.
  for (const id of [
    "claude-desktop",
    "vscode",
    "windsurf",
    "zed",
    "cline",
    "cline-cli",
    "antigravity",
    "mcporter",
  ]) {
    it(`${id} is no longer a provider`, () => {
      expect(() => getProvider(id)).toThrow(`unknown tool: ${id}`);
    });
  }

  it("all providers have unique IDs", () => {
    const providers = allProviders();
    const ids = providers.map((p) => p.id());
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("all providers have non-empty names", () => {
    for (const p of allProviders()) {
      expect(p.name().length).toBeGreaterThan(0);
    }
  });

  it("allSetupProviders returns sorted by priority", () => {
    const providers = allSetupProviders();
    for (let i = 1; i < providers.length; i++) {
      expect(providers[i].priority()).toBeGreaterThanOrEqual(providers[i - 1].priority());
    }
  });

  it("allSetupProviders excludes manual (no detectPaths)", () => {
    const ids = allSetupProviders().map((p) => p.id());
    expect(ids).not.toContain("manual");
  });

  it("getProvider returns correct provider by ID", () => {
    expect(getProvider("claude").name()).toBe("Claude Code");
    expect(getProvider("cursor").name()).toBe("Cursor");
    expect(getProvider("gemini").name()).toBe("Gemini CLI");
    expect(getProvider("manual").name()).toBe("Manual Configuration");
  });

  it("getProvider throws for unknown ID", () => {
    expect(() => getProvider("nonexistent")).toThrow("unknown tool: nonexistent");
  });

  describe("provider metadata", () => {
    const expectedProviders = [
      { id: "claude", name: "Claude Code", local: true },
      { id: "cursor", name: "Cursor", local: true },
      { id: "gemini", name: "Gemini CLI", local: true },
      { id: "codex", name: "Codex (CLI + Desktop)", local: true },
      { id: "copilot", name: "GitHub Copilot CLI", local: true },
      { id: "opencode", name: "OpenCode", local: true },
      { id: "factory", name: "Factory", local: true },
      { id: "pi", name: "Pi", local: false },
      { id: "manual", name: "Manual Configuration", local: false },
    ];

    for (const expected of expectedProviders) {
      it(`${expected.id}: name="${expected.name}", local=${expected.local}`, () => {
        const p = getProvider(expected.id);
        expect(p.name()).toBe(expected.name);
        expect(p.supportsLocal()).toBe(expected.local);
      });
    }
  });

  describe("SetupProvider accessors", () => {
    for (const p of allSetupProviders()) {
      describe(p.id(), () => {
        it("detectPaths returns string array", () => {
          expect(Array.isArray(p.detectPaths())).toBe(true);
        });

        it("isInstalled returns boolean", () => {
          expect(typeof p.isInstalled()).toBe("boolean");
        });

        it("globalConfigPath returns string", () => {
          expect(typeof p.globalConfigPath()).toBe("string");
        });

        it("isConfigured returns boolean", () => {
          expect(typeof p.isConfigured()).toBe("boolean");
        });
      });
    }
  });
});
