import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  DOSU_RULE_SECTION_END,
  DOSU_RULE_SECTION_START,
  DOSU_RULE_URLS,
  FALLBACK_DOSU_RULE,
  fetchDosuRule,
  GLOBAL_DOSU_SKILLS_GUIDANCE,
  installRuleForAgent,
  isRuleAgent,
  removeRuleForAgent,
  rulePathForAgent,
} from "./installer";

let tempDir: string;
let originalHome: string | undefined;
let originalClaudeConfigDir: string | undefined;
let originalCodexHome: string | undefined;

beforeEach(() => {
  tempDir = mkdtempSync(join(tmpdir(), "dosu-rules-"));
  originalHome = process.env.HOME;
  originalClaudeConfigDir = process.env.CLAUDE_CONFIG_DIR;
  originalCodexHome = process.env.CODEX_HOME;
  process.env.HOME = tempDir;
  delete process.env.CLAUDE_CONFIG_DIR;
  delete process.env.CODEX_HOME;
});

afterEach(() => {
  if (originalHome === undefined) delete process.env.HOME;
  else process.env.HOME = originalHome;
  if (originalClaudeConfigDir === undefined) delete process.env.CLAUDE_CONFIG_DIR;
  else process.env.CLAUDE_CONFIG_DIR = originalClaudeConfigDir;
  if (originalCodexHome === undefined) delete process.env.CODEX_HOME;
  else process.env.CODEX_HOME = originalCodexHome;
  rmSync(tempDir, { recursive: true, force: true });
  vi.restoreAllMocks();
});

describe("rule template", () => {
  it("keeps the bundled fallback aligned with the canonical repository file", () => {
    const canonical = readFileSync(join(process.cwd(), "rules", "dosu.md"), "utf-8");
    expect(FALLBACK_DOSU_RULE.trim()).toBe(canonical.trim());
  });

  it("uses the first available remote source", async () => {
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(new Response("remote rule", { status: 200 }));

    await expect(fetchDosuRule(fetchImpl)).resolves.toBe(
      `remote rule\n\n${GLOBAL_DOSU_SKILLS_GUIDANCE}\n`,
    );
    expect(fetchImpl).toHaveBeenCalledWith(DOSU_RULE_URLS[0]);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it("tries the backup source before using the bundled fallback", async () => {
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(new Response("", { status: 404 }))
      .mockResolvedValueOnce(new Response("backup rule", { status: 200 }));

    await expect(fetchDosuRule(fetchImpl)).resolves.toBe(
      `backup rule\n\n${GLOBAL_DOSU_SKILLS_GUIDANCE}\n`,
    );
    expect(fetchImpl).toHaveBeenNthCalledWith(2, DOSU_RULE_URLS[1]);
  });

  it("falls back when every remote request fails", async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockRejectedValue(new Error("offline"));

    await expect(fetchDosuRule(fetchImpl)).resolves.toBe(`${FALLBACK_DOSU_RULE.trim()}\n`);
    expect(fetchImpl).toHaveBeenCalledTimes(DOSU_RULE_URLS.length);
  });
});

describe("agent registry", () => {
  it("supports the same six mainstream agents as Context7 setup", () => {
    for (const agent of ["claude", "cursor", "codex", "opencode", "gemini", "antigravity"]) {
      expect(isRuleAgent(agent)).toBe(true);
    }
    expect(isRuleAgent("toString")).toBe(false);
  });

  it("resolves agent-specific global paths and environment overrides", () => {
    process.env.CLAUDE_CONFIG_DIR = join(tempDir, "custom-claude");
    process.env.CODEX_HOME = join(tempDir, "custom-codex");

    expect(rulePathForAgent("claude")).toBe(join(tempDir, "custom-claude", "rules", "dosu.md"));
    expect(rulePathForAgent("cursor")).toBe(join(tempDir, ".cursor", "rules", "dosu.mdc"));
    expect(rulePathForAgent("codex")).toBe(join(tempDir, "custom-codex", "AGENTS.md"));
    expect(rulePathForAgent("opencode")).toBe(join(tempDir, ".config", "opencode", "AGENTS.md"));
    expect(rulePathForAgent("gemini")).toBe(join(tempDir, ".gemini", "GEMINI.md"));
    expect(rulePathForAgent("antigravity")).toBe(join(tempDir, ".gemini", "GEMINI.md"));
    expect(rulePathForAgent("windsurf")).toBeNull();
  });

  it("keeps project rules inside the repository", () => {
    const root = join(tempDir, "repo");

    expect(rulePathForAgent("claude", root)).toBe(join(root, ".claude", "rules", "dosu.md"));
    expect(rulePathForAgent("cursor", root)).toBe(join(root, ".cursor", "rules", "dosu.mdc"));
    expect(rulePathForAgent("gemini", root)).toBe(join(root, "GEMINI.md"));
    expect(rulePathForAgent("codex", root)).toBeNull();
    expect(rulePathForAgent("opencode", root)).toBeNull();
    expect(rulePathForAgent("antigravity", root)).toBeNull();
  });
});

describe("standalone rule files", () => {
  it("creates, updates, and then leaves Claude's rule unchanged", () => {
    const first = installRuleForAgent("claude", "first rule");
    expect(first?.action).toBe("created");
    expect(readFileSync(first?.path ?? "", "utf-8")).toBe("first rule\n");

    const second = installRuleForAgent("claude", "second rule");
    expect(second?.action).toBe("updated");
    expect(readFileSync(second?.path ?? "", "utf-8")).toBe("second rule\n");

    const third = installRuleForAgent("claude", "second rule");
    expect(third?.action).toBe("unchanged");
  });

  it("adds alwaysApply frontmatter only to Cursor", () => {
    const cursor = installRuleForAgent("cursor", "shared rule");
    const claude = installRuleForAgent("claude", "shared rule");

    expect(readFileSync(cursor?.path ?? "", "utf-8")).toBe(
      "---\nalwaysApply: true\n---\n\nshared rule\n",
    );
    expect(readFileSync(claude?.path ?? "", "utf-8")).toBe("shared rule\n");
  });

  it("writes project rules without touching global rule paths", () => {
    const root = join(tempDir, "repo");
    const installed = installRuleForAgent("claude", "project rule", root);

    expect(installed?.path).toBe(join(root, ".claude", "rules", "dosu.md"));
    expect(readFileSync(installed?.path ?? "", "utf-8")).toContain("project rule\n");
    expect(existsSync(join(tempDir, ".claude", "rules", "dosu.md"))).toBe(false);
  });

  it.each([
    "claude",
    "cursor",
  ])("preserves a foreign project rule for %s during install and removal", (agent) => {
    const root = join(tempDir, "repo");
    const path = rulePathForAgent(agent, root) ?? "";
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, "user-authored rule\n");

    expect(() => installRuleForAgent(agent, "Dosu rule", root)).toThrow(/non-Dosu|refusing/);
    expect(() => removeRuleForAgent(agent, root)).toThrow(/non-Dosu|refusing/);
    expect(readFileSync(path, "utf-8")).toBe("user-authored rule\n");
  });

  it.each([
    "claude",
    "cursor",
  ])("recognizes and removes its own CRLF project rule for %s", (agent) => {
    const root = join(tempDir, "repo");
    const installed = installRuleForAgent(agent, "Dosu rule", root);
    const path = installed?.path ?? "";
    writeFileSync(path, readFileSync(path, "utf-8").replaceAll("\n", "\r\n"));

    expect(removeRuleForAgent(agent, root)?.action).toBe("removed");
    expect(existsSync(path)).toBe(false);
  });

  it("removes a standalone rule idempotently", () => {
    const installed = installRuleForAgent("claude", "rule");
    expect(removeRuleForAgent("claude")?.action).toBe("removed");
    expect(existsSync(installed?.path ?? "")).toBe(false);
    expect(removeRuleForAgent("claude")?.action).toBe("not_found");
  });
});

describe("marker-delimited instruction sections", () => {
  it("preserves surrounding Codex instructions and replaces only the Dosu section", () => {
    const path = rulePathForAgent("codex");
    expect(path).not.toBeNull();
    mkdirSync(dirname(path ?? ""), { recursive: true });
    writeFileSync(path ?? "", "# Before\n\n# After\n", { encoding: "utf-8", flag: "w" });

    const first = installRuleForAgent("codex", "first rule");
    expect(first?.action).toBe("updated");
    const installed = readFileSync(path ?? "", "utf-8");
    expect(installed).toContain("# Before");
    expect(installed).toContain("# After");
    expect(installed).toContain("first rule");

    const second = installRuleForAgent("codex", "second rule");
    expect(second?.action).toBe("updated");
    const updated = readFileSync(path ?? "", "utf-8");
    expect(updated).not.toContain("first rule");
    expect(updated).toContain("second rule");
    expect(updated.match(new RegExp(DOSU_RULE_SECTION_START, "g"))).toHaveLength(1);
    expect(updated.match(/<!-- dosu:rules:end -->/g)).toHaveLength(1);

    expect(installRuleForAgent("codex", "second rule")?.action).toBe("unchanged");
  });

  it("shares one idempotent GEMINI.md section between Gemini and Antigravity", () => {
    const gemini = installRuleForAgent("gemini", "shared rule");
    const antigravity = installRuleForAgent("antigravity", "shared rule");

    expect(gemini?.path).toBe(antigravity?.path);
    expect(antigravity?.action).toBe("unchanged");
    const content = readFileSync(gemini?.path ?? "", "utf-8");
    expect(content.match(new RegExp(DOSU_RULE_SECTION_START, "g"))).toHaveLength(1);
  });

  it("removes only the marked section and preserves surrounding content", () => {
    const installed = installRuleForAgent("opencode", "rule");
    const path = installed?.path ?? "";
    writeFileSync(path, `# Before\n\n${readFileSync(path, "utf-8")}\n# After\n`, "utf-8");

    expect(removeRuleForAgent("opencode")?.action).toBe("removed");
    const content = readFileSync(path, "utf-8");
    expect(content).toBe("# Before\n\n# After\n");
    expect(content).not.toContain(DOSU_RULE_SECTION_START);
    expect(content).not.toContain(DOSU_RULE_SECTION_END);
    expect(removeRuleForAgent("opencode")?.action).toBe("not_found");
  });

  it("preserves CRLF line endings while installing, updating, and removing a section", () => {
    const path = rulePathForAgent("codex") ?? "";
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, "# Before\r\n\r\n# After\r\n", "utf-8");

    expect(installRuleForAgent("codex", "first rule")?.action).toBe("updated");
    expect(readFileSync(path, "utf-8")).toBe(
      `# Before\r\n\r\n# After\r\n\r\n${DOSU_RULE_SECTION_START}\r\nfirst rule\r\n${DOSU_RULE_SECTION_END}\r\n`,
    );

    expect(installRuleForAgent("codex", "second rule")?.action).toBe("updated");
    expect(readFileSync(path, "utf-8")).toContain(
      `${DOSU_RULE_SECTION_START}\r\nsecond rule\r\n${DOSU_RULE_SECTION_END}`,
    );

    expect(removeRuleForAgent("codex")?.action).toBe("removed");
    expect(readFileSync(path, "utf-8")).toBe("# Before\r\n\r\n# After\r\n");
  });

  it("deletes a generated instruction file when no user content remains", () => {
    const installed = installRuleForAgent("codex", "rule");
    expect(removeRuleForAgent("codex")?.action).toBe("removed");
    expect(existsSync(installed?.path ?? "")).toBe(false);
  });

  it("refuses to overwrite a file with incomplete markers", () => {
    const path = rulePathForAgent("codex");
    mkdirSync(dirname(path ?? ""), { recursive: true });
    writeFileSync(path ?? "", `${DOSU_RULE_SECTION_START}\nbroken\n`, "utf-8");

    expect(() => installRuleForAgent("codex", "new rule")).toThrow(
      "Dosu rule markers are incomplete",
    );
  });

  it("ignores unsupported agents", () => {
    expect(installRuleForAgent("windsurf", "rule")).toBeNull();
    expect(removeRuleForAgent("windsurf")).toBeNull();
  });
});
