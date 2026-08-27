import { describe, expect, it } from "vitest";
import { allProviders, allSetupProviders, getProvider } from "./providers";

describe("provider registry", () => {
  it("allProviders returns 16 providers", () => {
    const providers = allProviders();
    expect(providers).toHaveLength(16);
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
      { id: "claude", name: "Claude Code", kind: "project" },
      { id: "claude-desktop", name: "Claude Desktop", kind: "global-connector" },
      { id: "cursor", name: "Cursor", kind: "project" },
      { id: "vscode", name: "VS Code", kind: "project" },
      { id: "gemini", name: "Gemini CLI", kind: "project" },
      { id: "codex", name: "Codex", kind: "project" },
      { id: "windsurf", name: "Windsurf", kind: "unsupported" },
      { id: "zed", name: "Zed", kind: "project" },
      { id: "cline", name: "Cline", kind: "unsupported" },
      { id: "cline-cli", name: "Cline CLI", kind: "unsupported" },
      { id: "copilot", name: "GitHub Copilot CLI", kind: "project" },
      { id: "opencode", name: "OpenCode", kind: "project" },
      { id: "antigravity", name: "Antigravity", kind: "unsupported" },
      { id: "mcporter", name: "MCPorter", kind: "project" },
      { id: "factory", name: "Factory", kind: "project" },
      { id: "manual", name: "Manual Configuration", kind: "global-connector" },
    ];

    for (const expected of expectedProviders) {
      it(`${expected.id}: name="${expected.name}", kind=${expected.kind}`, () => {
        const p = getProvider(expected.id);
        expect(p.name()).toBe(expected.name);
        expect(p.configurationKind()).toBe(expected.kind);
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

        it("reports project configuration capability consistently", () => {
          const projectRoot = "/tmp/dosu-provider-project";
          if (p.configurationKind() === "project") {
            expect(typeof p.projectConfigPath(projectRoot)).toBe("string");
            expect(typeof p.isProjectConfigured(projectRoot)).toBe("boolean");
          } else {
            expect(p.projectConfigPath(projectRoot)).toBeNull();
            expect(p.isProjectConfigured(projectRoot)).toBe(false);
          }
        });
      });
    }
  });
});
