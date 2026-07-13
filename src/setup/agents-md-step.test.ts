import { execSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as p from "@clack/prompts";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  buildDosuAgentsSection,
  DOSU_SECTION_END,
  DOSU_SECTION_START,
  inGitWorkTree,
  stepUpdateAgentsMd,
  upsertDosuAgentsSection,
} from "./agents-md-step";

vi.mock("@clack/prompts", () => ({
  log: {
    success: vi.fn(),
    error: vi.fn(),
  },
}));

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "dosu-agents-md-"));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
  vi.clearAllMocks();
});

describe("buildDosuAgentsSection", () => {
  it("wraps the section in the dosu markers", () => {
    const section = buildDosuAgentsSection("dosu");
    expect(section.startsWith(DOSU_SECTION_START)).toBe(true);
    expect(section.endsWith(DOSU_SECTION_END)).toBe(true);
    expect(section).toContain("read_knowledge");
    expect(section).toContain("write_knowledge");
  });

  it("embeds the given dosu invocation", () => {
    expect(buildDosuAgentsSection("npx -y @dosu/cli")).toContain("`npx -y @dosu/cli setup`");
  });
});

describe("inGitWorkTree", () => {
  it("returns false outside a git repo", () => {
    expect(inGitWorkTree(dir)).toBe(false);
  });

  it("returns true inside a git repo", () => {
    execSync("git init", { cwd: dir, stdio: "ignore" });
    expect(inGitWorkTree(dir)).toBe(true);
  });
});

describe("upsertDosuAgentsSection", () => {
  it("creates AGENTS.md when missing", () => {
    const result = upsertDosuAgentsSection(dir, "dosu");
    expect(result.action).toBe("created");
    const content = readFileSync(result.path, "utf-8");
    expect(content).toContain(DOSU_SECTION_START);
    expect(content.endsWith("\n")).toBe(true);
  });

  it("appends the section to an existing file without markers", () => {
    const path = join(dir, "AGENTS.md");
    writeFileSync(path, "# My project\n\nSome instructions.\n");
    const result = upsertDosuAgentsSection(dir, "dosu");
    expect(result.action).toBe("updated");
    const content = readFileSync(path, "utf-8");
    expect(content.startsWith("# My project")).toBe(true);
    expect(content).toContain(DOSU_SECTION_START);
    expect(content.indexOf("Some instructions.")).toBeLessThan(content.indexOf(DOSU_SECTION_START));
  });

  it("replaces an existing marked section in place", () => {
    const path = join(dir, "AGENTS.md");
    writeFileSync(
      path,
      `# Top\n\n${DOSU_SECTION_START}\nold stale content\n${DOSU_SECTION_END}\n\n# Bottom\n`,
    );
    const result = upsertDosuAgentsSection(dir, "dosu");
    expect(result.action).toBe("updated");
    const content = readFileSync(path, "utf-8");
    expect(content).not.toContain("old stale content");
    expect(content).toContain("read_knowledge");
    expect(content.indexOf("# Top")).toBeLessThan(content.indexOf(DOSU_SECTION_START));
    expect(content.indexOf(DOSU_SECTION_END)).toBeLessThan(content.indexOf("# Bottom"));
    expect(content.match(new RegExp(DOSU_SECTION_START, "g"))).toHaveLength(1);
  });

  it("is idempotent — a second run reports unchanged", () => {
    upsertDosuAgentsSection(dir, "dosu");
    const result = upsertDosuAgentsSection(dir, "dosu");
    expect(result.action).toBe("unchanged");
  });
});

describe("stepUpdateAgentsMd", () => {
  it("returns true and logs success on create", () => {
    expect(stepUpdateAgentsMd(dir)).toBe(true);
    expect(p.log.success).toHaveBeenCalled();
  });

  it("returns true when already up to date", () => {
    upsertDosuAgentsSection(dir);
    expect(stepUpdateAgentsMd(dir)).toBe(true);
    expect(vi.mocked(p.log.success).mock.calls[0][0]).toContain("already up to date");
  });

  it("returns false and logs error when the write fails", () => {
    expect(stepUpdateAgentsMd(join(dir, "does-not-exist"))).toBe(false);
    expect(p.log.error).toHaveBeenCalled();
  });
});
