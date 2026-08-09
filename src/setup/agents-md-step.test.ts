import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as p from "@clack/prompts";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  buildDosuAgentsSection,
  DOSU_SECTION_END,
  DOSU_SECTION_START,
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
  it("wraps the canonical instruction in the dosu markers without extra headings", () => {
    const section = buildDosuAgentsSection("Canonical paragraph one.\n\nCanonical paragraph two.");
    expect(section.startsWith(DOSU_SECTION_START)).toBe(true);
    expect(section.endsWith(DOSU_SECTION_END)).toBe(true);
    expect(section).toContain("Canonical paragraph one.\n\nCanonical paragraph two.");
    expect(section).not.toContain("## Dosu");
  });

  it("uses the repository's canonical instruction by default", () => {
    const canonical = readFileSync(join(process.cwd(), "rules", "dosu.md"), "utf-8").trim();
    expect(buildDosuAgentsSection()).toBe(
      `${DOSU_SECTION_START}\n${canonical}\n${DOSU_SECTION_END}`,
    );
  });
});

describe("upsertDosuAgentsSection", () => {
  it("creates AGENTS.md when missing", () => {
    const result = upsertDosuAgentsSection(dir, "canonical instruction");
    expect(result.action).toBe("created");
    const content = readFileSync(result.path, "utf-8");
    expect(content).toContain(DOSU_SECTION_START);
    expect(content.endsWith("\n")).toBe(true);
  });

  it("appends the section to an existing file without markers", () => {
    const path = join(dir, "AGENTS.md");
    writeFileSync(path, "# My project\n\nSome instructions.\n");
    const result = upsertDosuAgentsSection(dir, "canonical instruction");
    expect(result.action).toBe("updated");
    const content = readFileSync(path, "utf-8");
    expect(content.startsWith("# My project")).toBe(true);
    expect(content).toContain(DOSU_SECTION_START);
    expect(content.indexOf("Some instructions.")).toBeLessThan(content.indexOf(DOSU_SECTION_START));
  });

  it("preserves CRLF line endings when appending the section", () => {
    const path = join(dir, "AGENTS.md");
    writeFileSync(path, "# My project\r\n\r\nSome instructions.\r\n");

    expect(upsertDosuAgentsSection(dir, "canonical instruction").action).toBe("updated");
    expect(readFileSync(path, "utf-8")).toBe(
      `# My project\r\n\r\nSome instructions.\r\n\r\n${DOSU_SECTION_START}\r\ncanonical instruction\r\n${DOSU_SECTION_END}\r\n`,
    );
    expect(upsertDosuAgentsSection(dir, "canonical instruction").action).toBe("unchanged");
  });

  it("replaces an existing marked section in place", () => {
    const path = join(dir, "AGENTS.md");
    writeFileSync(
      path,
      `# Top\n\n${DOSU_SECTION_START}\nold stale content\n${DOSU_SECTION_END}\n\n# Bottom\n`,
    );
    const result = upsertDosuAgentsSection(dir, "canonical instruction");
    expect(result.action).toBe("updated");
    const content = readFileSync(path, "utf-8");
    expect(content).not.toContain("old stale content");
    expect(content).toContain("canonical instruction");
    expect(content.indexOf("# Top")).toBeLessThan(content.indexOf(DOSU_SECTION_START));
    expect(content.indexOf(DOSU_SECTION_END)).toBeLessThan(content.indexOf("# Bottom"));
    expect(content.match(new RegExp(DOSU_SECTION_START, "g"))).toHaveLength(1);
  });

  it.each([
    ["the original unversioned marker", "<!-- dosu:mcp:start -->"],
    ["the v1 marker", "<!-- dosu:mcp:start v1 -->"],
  ])("replaces a section left by %s", (_label, startMarker) => {
    const path = join(dir, "AGENTS.md");
    writeFileSync(path, `# Top\n\n${startMarker}\nold content\n${DOSU_SECTION_END}\n`);
    const result = upsertDosuAgentsSection(dir, "canonical instruction");
    expect(result.action).toBe("updated");
    const content = readFileSync(path, "utf-8");
    expect(content).not.toContain("old content");
    expect(content).toContain(DOSU_SECTION_START);
    expect(content.match(/<!-- dosu:mcp:start(?: v\d+)? -->/g)).toHaveLength(1);
    expect(content.match(/<!-- dosu:mcp:end -->/g)).toHaveLength(1);
  });

  it("is idempotent — a second run reports unchanged", () => {
    upsertDosuAgentsSection(dir, "canonical instruction");
    const result = upsertDosuAgentsSection(dir, "canonical instruction");
    expect(result.action).toBe("unchanged");
  });

  it.each([
    `${DOSU_SECTION_START}\nbroken\n`,
    `orphan end\n${DOSU_SECTION_END}\n`,
  ])("refuses to overwrite incomplete markers", (existing) => {
    const path = join(dir, "AGENTS.md");
    writeFileSync(path, existing);

    expect(() => upsertDosuAgentsSection(dir, "canonical instruction")).toThrow(
      "Dosu AGENTS.md markers are incomplete",
    );
    expect(readFileSync(path, "utf-8")).toBe(existing);
  });
});

describe("stepUpdateAgentsMd", () => {
  it("returns true and logs success on create", async () => {
    await expect(stepUpdateAgentsMd(dir, "canonical instruction")).resolves.toBe(true);
    expect(p.log.success).toHaveBeenCalledWith(expect.stringContaining(join(dir, "AGENTS.md")));
    expect(p.log.success).toHaveBeenCalledWith(expect.stringContaining("(created)"));
  });

  it("returns true when already up to date", async () => {
    upsertDosuAgentsSection(dir, "canonical instruction");
    await expect(stepUpdateAgentsMd(dir, "canonical instruction")).resolves.toBe(true);
    expect(p.log.success).toHaveBeenCalledWith(expect.stringContaining(join(dir, "AGENTS.md")));
    expect(p.log.success).toHaveBeenCalledWith(expect.stringContaining("(already up to date)"));
  });

  it("returns false and logs error when the write fails", async () => {
    await expect(
      stepUpdateAgentsMd(join(dir, "does-not-exist"), "canonical instruction"),
    ).resolves.toBe(false);
    expect(p.log.error).toHaveBeenCalled();
  });
});
