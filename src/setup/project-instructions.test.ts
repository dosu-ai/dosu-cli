import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { DOSU_SECTION_START } from "./agents-md-step";
import {
  installProjectInstructions,
  PROJECT_ADAPTER_END,
  PROJECT_ADAPTER_START,
  removeProjectInstructionAdapters,
  verifyProjectInstructions,
} from "./project-instructions";

let projectRoot: string;

beforeEach(() => {
  projectRoot = mkdtempSync(join(tmpdir(), "dosu-project-instructions-"));
});

afterEach(() => {
  rmSync(projectRoot, { recursive: true, force: true });
});

describe("installProjectInstructions", () => {
  it("keeps one canonical rule in AGENTS.md and adds only thin provider adapters", () => {
    const result = installProjectInstructions({
      projectRoot,
      providerIDs: ["claude", "codex", "gemini", "cursor"],
      content: "Always consult Dosu.",
    });

    expect(readFileSync(join(projectRoot, "AGENTS.md"), "utf8")).toContain(DOSU_SECTION_START);
    expect(readFileSync(join(projectRoot, "AGENTS.md"), "utf8")).toContain("Always consult Dosu.");
    expect(readFileSync(join(projectRoot, "CLAUDE.md"), "utf8")).toContain("@AGENTS.md");
    expect(readFileSync(join(projectRoot, "GEMINI.md"), "utf8")).toContain("@AGENTS.md");
    expect(result.adapters.map((adapter) => adapter.provider)).toEqual(["claude", "gemini"]);
    expect(existsSync(join(projectRoot, ".codex", "AGENTS.md"))).toBe(false);
    expect(existsSync(join(projectRoot, ".cursor", "rules", "dosu.mdc"))).toBe(false);
  });

  it("writes Antigravity's official project rule adapter", () => {
    installProjectInstructions({
      projectRoot,
      providerIDs: ["antigravity"],
      content: "Use Dosu knowledge.",
    });

    const rule = readFileSync(join(projectRoot, ".agents", "rules", "dosu.md"), "utf8");
    expect(rule).toContain(PROJECT_ADAPTER_START);
    expect(rule).toContain("Use Dosu knowledge.");
  });

  it("preserves user content and updates its marker block idempotently", () => {
    writeFileSync(join(projectRoot, "CLAUDE.md"), "# User instructions\n");

    installProjectInstructions({
      projectRoot,
      providerIDs: ["claude"],
      content: "first",
    });
    const second = installProjectInstructions({
      projectRoot,
      providerIDs: ["claude"],
      content: "second",
    });

    const content = readFileSync(join(projectRoot, "CLAUDE.md"), "utf8");
    expect(content).toContain("# User instructions");
    expect(content.match(new RegExp(PROJECT_ADAPTER_START, "g"))).toHaveLength(1);
    expect(content).toContain("@AGENTS.md");
    expect(second.adapters[0]?.action).toBe("unchanged");
  });

  it("keeps a CLAUDE.md symlink to AGENTS.md instead of replacing it", () => {
    writeFileSync(join(projectRoot, "AGENTS.md"), "# Team instructions\n");
    symlinkSync("AGENTS.md", join(projectRoot, "CLAUDE.md"));

    installProjectInstructions({
      projectRoot,
      providerIDs: ["claude"],
      content: "Use Dosu knowledge.",
    });

    expect(lstatSync(join(projectRoot, "CLAUDE.md")).isSymbolicLink()).toBe(true);
    expect(verifyProjectInstructions(projectRoot, ["claude"])).toBe(true);
  });

  it("refuses to follow a foreign project-instruction symlink", () => {
    const outside = join(projectRoot, "outside.md");
    writeFileSync(outside, "# Do not edit\n");
    symlinkSync("outside.md", join(projectRoot, "CLAUDE.md"));

    expect(() =>
      installProjectInstructions({
        projectRoot,
        providerIDs: ["claude"],
        content: "Use Dosu knowledge.",
      }),
    ).toThrow(/symbolic link/i);
    expect(readFileSync(outside, "utf8")).toBe("# Do not edit\n");
  });

  it("does not follow a predictable adapter temporary-file symlink", () => {
    const victim = join(projectRoot, "user-data.md");
    const adapter = join(projectRoot, "CLAUDE.md");
    writeFileSync(victim, "USER DATA\n");
    symlinkSync("user-data.md", `${adapter}.${process.pid}.tmp`);

    expect(() =>
      installProjectInstructions({
        projectRoot,
        providerIDs: ["claude"],
        content: "Use Dosu knowledge.",
      }),
    ).not.toThrow();

    expect(readFileSync(victim, "utf8")).toBe("USER DATA\n");
    expect(lstatSync(adapter).isFile()).toBe(true);
  });

  it("refuses a canonical AGENTS.md symlink that could escape the repository", () => {
    const outside = join(projectRoot, "outside-agents.md");
    writeFileSync(outside, "# Do not edit\n");
    symlinkSync("outside-agents.md", join(projectRoot, "AGENTS.md"));

    expect(() =>
      installProjectInstructions({
        projectRoot,
        providerIDs: ["codex"],
        content: "Use Dosu knowledge.",
      }),
    ).toThrow(/symbolic link/i);
    expect(readFileSync(outside, "utf8")).toBe("# Do not edit\n");
  });

  it("refuses a symlinked adapter parent directory", () => {
    const outside = join(projectRoot, "outside-agents-dir");
    mkdirSync(outside);
    symlinkSync("outside-agents-dir", join(projectRoot, ".agents"));

    expect(() =>
      installProjectInstructions({
        projectRoot,
        providerIDs: ["antigravity"],
        content: "Use Dosu knowledge.",
      }),
    ).toThrow(/symbolic link/i);
    expect(existsSync(join(outside, "rules", "dosu.md"))).toBe(false);
  });

  it("refuses an incomplete adapter marker without changing the file", () => {
    const path = join(projectRoot, "GEMINI.md");
    const original = `${PROJECT_ADAPTER_START}\n@AGENTS.md\n`;
    writeFileSync(path, original);

    expect(() =>
      installProjectInstructions({
        projectRoot,
        providerIDs: ["gemini"],
        content: "rule",
      }),
    ).toThrow(/markers are incomplete/i);
    expect(readFileSync(path, "utf8")).toBe(original);
  });

  it("refuses duplicate canonical AGENTS.md marker blocks", () => {
    writeFileSync(
      join(projectRoot, "AGENTS.md"),
      `${DOSU_SECTION_START}\none\n<!-- dosu:mcp:end -->\n${DOSU_SECTION_START}\ntwo\n<!-- dosu:mcp:end -->\n`,
    );

    expect(() =>
      installProjectInstructions({
        projectRoot,
        providerIDs: ["codex"],
        content: "Use Dosu knowledge.",
      }),
    ).toThrow(/multiple/i);
  });
});

describe("verifyProjectInstructions", () => {
  it("requires both the canonical section and each required adapter", () => {
    installProjectInstructions({
      projectRoot,
      providerIDs: ["claude", "gemini", "codex"],
      content: "rule",
    });
    expect(verifyProjectInstructions(projectRoot, ["claude", "gemini", "codex"])).toBe(true);

    rmSync(join(projectRoot, "CLAUDE.md"));
    expect(verifyProjectInstructions(projectRoot, ["claude", "gemini", "codex"])).toBe(false);
  });
});

describe("removeProjectInstructionAdapters", () => {
  it("removes only Dosu's adapter block and leaves user content", () => {
    writeFileSync(join(projectRoot, "CLAUDE.md"), "# User instructions\n");
    installProjectInstructions({ projectRoot, providerIDs: ["claude"], content: "rule" });

    removeProjectInstructionAdapters(projectRoot, ["claude"]);

    const content = readFileSync(join(projectRoot, "CLAUDE.md"), "utf8");
    expect(content).toContain("# User instructions");
    expect(content).not.toContain(PROJECT_ADAPTER_START);
    expect(content).not.toContain(PROJECT_ADAPTER_END);
  });

  it("removes only the marker bytes and preserves all surrounding whitespace", () => {
    const path = join(projectRoot, "CLAUDE.md");
    const before = "  user prefix\n\n\n\n";
    const after = "\n\n\nuser suffix  \n";
    writeFileSync(
      path,
      `${before}${PROJECT_ADAPTER_START}\n@AGENTS.md\n${PROJECT_ADAPTER_END}${after}`,
    );

    removeProjectInstructionAdapters(projectRoot, ["claude"]);

    expect(readFileSync(path, "utf8")).toBe(`${before}${after}`);
  });
});
