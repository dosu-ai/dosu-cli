import { beforeEach, describe, expect, it, vi } from "vitest";
import type { SetupProvider } from "../mcp/providers";

const {
  mockFetchDosuRule,
  mockInstallRuleForAgent,
  mockRemoveRuleForAgent,
  mockIsRuleAgent,
  mockRulePathForAgent,
} = vi.hoisted(() => ({
  mockFetchDosuRule: vi.fn(),
  mockInstallRuleForAgent: vi.fn(),
  mockRemoveRuleForAgent: vi.fn(),
  mockIsRuleAgent: vi.fn(),
  mockRulePathForAgent: vi.fn(),
}));

vi.mock("../rules/installer", () => ({
  fetchDosuRule: mockFetchDosuRule,
  installRuleForAgent: mockInstallRuleForAgent,
  removeRuleForAgent: mockRemoveRuleForAgent,
  isRuleAgent: mockIsRuleAgent,
  rulePathForAgent: mockRulePathForAgent,
}));

vi.mock("../debug/logger", () => ({
  logger: {
    error: vi.fn(),
  },
}));

vi.mock("@clack/prompts", () => ({
  log: {
    success: vi.fn(),
    info: vi.fn(),
    error: vi.fn(),
  },
}));

import * as p from "@clack/prompts";
import { stepConfigureAgentRules } from "./rules-step";

function makeProvider(id: string): SetupProvider {
  return {
    id: () => id,
    name: () => `Agent ${id}`,
    supportsLocal: () => true,
    install: vi.fn(),
    remove: vi.fn(),
    detectPaths: () => [],
    isInstalled: () => true,
    isConfigured: () => false,
    globalConfigPath: () => `/config/${id}`,
    projectConfigPath: (root) => `${root}/config/${id}`,
    isProjectConfigured: () => false,
    priority: () => 0,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  mockFetchDosuRule.mockResolvedValue("canonical rule\n");
  mockIsRuleAgent.mockImplementation((agent: string) =>
    ["claude", "cursor", "codex", "opencode", "gemini", "antigravity"].includes(agent),
  );
  mockRulePathForAgent.mockImplementation((agent: string) =>
    agent === "gemini" || agent === "antigravity" ? "/rules/GEMINI.md" : `/rules/${agent}.md`,
  );
  mockInstallRuleForAgent.mockImplementation((agent: string) => ({
    agent,
    action: "created",
    path: mockRulePathForAgent(agent),
  }));
  mockRemoveRuleForAgent.mockImplementation((agent: string) => ({
    agent,
    action: "removed",
    path: mockRulePathForAgent(agent),
  }));
});

describe("stepConfigureAgentRules", () => {
  it("leaves Codex project instructions to the canonical AGENTS.md step", async () => {
    const codex = makeProvider("codex");
    mockRulePathForAgent.mockReturnValue(null);

    const results = await stepConfigureAgentRules(
      { toInstall: [codex], toRemove: [] },
      [{ provider: codex, action: "install" }],
      "/repo",
    );

    expect(results).toEqual([]);
    expect(mockFetchDosuRule).not.toHaveBeenCalled();
  });

  it("passes the verified project root to rule installation", async () => {
    const claude = makeProvider("claude");

    await stepConfigureAgentRules(
      { toInstall: [claude], toRemove: [] },
      [{ provider: claude, action: "install" }],
      "/repo",
    );

    expect(mockInstallRuleForAgent).toHaveBeenCalledWith("claude", "canonical rule\n", "/repo");
  });

  it("installs one fetched rule for every successfully configured supported agent", async () => {
    const claude = makeProvider("claude");
    const cursor = makeProvider("cursor");
    const windsurf = makeProvider("windsurf");
    const selection = {
      toInstall: [claude, cursor, windsurf],
      toRemove: [],
    };
    const mcpResults = [
      { provider: claude, action: "install" as const },
      { provider: cursor, action: "install" as const },
      { provider: windsurf, action: "install" as const },
    ];

    const results = await stepConfigureAgentRules(selection, mcpResults);

    expect(mockFetchDosuRule).toHaveBeenCalledTimes(1);
    expect(mockInstallRuleForAgent).toHaveBeenCalledTimes(2);
    expect(mockInstallRuleForAgent).toHaveBeenCalledWith("claude", "canonical rule\n", undefined);
    expect(mockInstallRuleForAgent).toHaveBeenCalledWith("cursor", "canonical rule\n", undefined);
    expect(results).toHaveLength(2);
    expect(p.log.success).toHaveBeenCalledWith(expect.stringContaining("Rules ready for 2 agent"));
    expect(p.log.success).toHaveBeenCalledWith(expect.stringContaining("Agent claude"));
    expect(p.log.success).toHaveBeenCalledWith(expect.stringContaining("/rules/claude.md"));
  });

  it("does not install a rule when MCP configuration failed", async () => {
    const claude = makeProvider("claude");

    const results = await stepConfigureAgentRules({ toInstall: [claude], toRemove: [] }, [
      { provider: claude, action: "install", error: new Error("disk full") },
    ]);

    expect(results).toEqual([]);
    expect(mockFetchDosuRule).not.toHaveBeenCalled();
    expect(mockInstallRuleForAgent).not.toHaveBeenCalled();
  });

  it("removes the rule after a successful MCP removal", async () => {
    const codex = makeProvider("codex");

    const results = await stepConfigureAgentRules({ toInstall: [], toRemove: [codex] }, [
      { provider: codex, action: "remove" },
    ]);

    expect(mockRemoveRuleForAgent).toHaveBeenCalledWith("codex", undefined);
    expect(results).toEqual([
      expect.objectContaining({ provider: codex, action: "removed", path: "/rules/codex.md" }),
    ]);
    expect(p.log.info).toHaveBeenCalledWith(expect.stringContaining("Rules removed from 1 agent"));
  });

  it("keeps a shared GEMINI.md rule when the other Gemini-family agent remains selected", async () => {
    const gemini = makeProvider("gemini");
    const antigravity = makeProvider("antigravity");

    await stepConfigureAgentRules({ toInstall: [gemini], toRemove: [antigravity] }, [
      { provider: gemini, action: "install" },
      { provider: antigravity, action: "remove" },
    ]);

    expect(mockInstallRuleForAgent).toHaveBeenCalledWith("gemini", "canonical rule\n", undefined);
    expect(mockRemoveRuleForAgent).not.toHaveBeenCalled();
  });

  it("reports one rule failure without preventing other agents from installing", async () => {
    const claude = makeProvider("claude");
    const cursor = makeProvider("cursor");
    mockInstallRuleForAgent
      .mockImplementationOnce(() => {
        throw new Error("permission denied");
      })
      .mockImplementationOnce((agent: string) => ({
        agent,
        action: "created",
        path: "/rules/cursor.md",
      }));

    const results = await stepConfigureAgentRules({ toInstall: [claude, cursor], toRemove: [] }, [
      { provider: claude, action: "install" },
      { provider: cursor, action: "install" },
    ]);

    expect(results).toHaveLength(2);
    expect(results[0].error?.message).toBe("permission denied");
    expect(results[1]).toMatchObject({ action: "created", path: "/rules/cursor.md" });
    expect(p.log.error).toHaveBeenCalledWith(expect.stringContaining("permission denied"));
  });

  it("reports a rule removal failure without throwing", async () => {
    const codex = makeProvider("codex");
    mockRemoveRuleForAgent.mockImplementationOnce(() => {
      throw new Error("read only");
    });

    const results = await stepConfigureAgentRules({ toInstall: [], toRemove: [codex] }, [
      { provider: codex, action: "remove" },
    ]);

    expect(results[0]).toMatchObject({ action: "not_found", path: "/rules/codex.md" });
    expect(results[0].error?.message).toBe("read only");
    expect(p.log.error).toHaveBeenCalledWith(expect.stringContaining("read only"));
  });
});
