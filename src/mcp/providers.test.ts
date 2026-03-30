import { describe, it, expect } from "vitest";
import { allProviders, allSetupProviders, getProvider } from "./providers";

describe("provider registry", () => {
  it("allProviders returns 15 providers", () => {
    const providers = allProviders();
    expect(providers).toHaveLength(15);
  });

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
      { id: "claude-desktop", name: "Claude Desktop", local: false },
      { id: "cursor", name: "Cursor", local: true },
      { id: "vscode", name: "VS Code", local: true },
      { id: "gemini", name: "Gemini CLI", local: true },
      { id: "codex", name: "Codex CLI", local: true },
      { id: "windsurf", name: "Windsurf", local: false },
      { id: "zed", name: "Zed", local: true },
      { id: "cline", name: "Cline", local: false },
      { id: "cline-cli", name: "Cline CLI", local: false },
      { id: "copilot", name: "GitHub Copilot CLI", local: true },
      { id: "opencode", name: "OpenCode", local: true },
      { id: "antigravity", name: "Antigravity", local: false },
      { id: "mcporter", name: "MCPorter", local: true },
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
});
