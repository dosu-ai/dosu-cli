import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readlinkSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  home: "",
  /** When set, `symlinkSync` / `rmSync` throw this instead of touching the disk. */
  symlinkError: null as Error | null,
  rmError: null as Error | null,
}));
vi.mock("node:os", async (importOriginal) => ({
  ...(await importOriginal<typeof import("node:os")>()),
  homedir: () => mocks.home,
}));
// ESM namespaces cannot be spied on, so wrap the two fs calls whose failure paths are under test.
vi.mock("node:fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs")>();
  return {
    ...actual,
    symlinkSync: (...args: Parameters<typeof actual.symlinkSync>) => {
      if (mocks.symlinkError) throw mocks.symlinkError;
      return actual.symlinkSync(...args);
    },
    rmSync: (...args: Parameters<typeof actual.rmSync>) => {
      if (mocks.rmError) throw mocks.rmError;
      return actual.rmSync(...args);
    },
  };
});

vi.mock("../generated/skills", () => ({
  BUNDLED_SKILLS: [
    {
      name: "dosu",
      files: [
        { path: "SKILL.md", content: "# dosu\n", executable: false },
        { path: "references/commands.md", content: "commands\n", executable: false },
      ],
    },
    {
      name: "read-knowledge-impact",
      files: [
        { path: "SKILL.md", content: "# impact\n", executable: false },
        { path: "scripts/run.py", content: "#!/usr/bin/env python3\n", executable: true },
      ],
    },
  ],
}));

vi.mock("../version/version", () => ({ VERSION: "9.9.9" }));

import {
  installBundledSkills,
  installSkill,
  readSkillInstallState,
  removeSkills,
  skillAgentIDsForProviders,
  skillCommand,
  skillInstallTargetForProvider,
} from "./skill";

let logSpy: ReturnType<typeof vi.spyOn>;
let errorSpy: ReturnType<typeof vi.spyOn>;
// biome-ignore lint/suspicious/noExplicitAny: process.exit mock type mismatch
let exitSpy: any;

let tempDir: string;
let origXDG: string | undefined;

const universal = () => join(mocks.home, ".agents", "skills");
const claude = () => join(mocks.home, ".claude", "skills");
const windsurf = () => join(mocks.home, ".codeium", "windsurf", "skills");
const statePath = () => join(tempDir, "xdg", "dosu-cli", "skill-install.json");
const lockPath = () => join(mocks.home, ".agents", ".skill-lock.json");

function allOutput(): string {
  return logSpy.mock.calls.map((c: unknown[]) => c.join(" ")).join("\n");
}

function allErrors(): string {
  return errorSpy.mock.calls.map((c: unknown[]) => c.join(" ")).join("\n");
}

async function run(...args: string[]) {
  const cmd = skillCommand();
  cmd.exitOverride();
  await cmd.parseAsync(["node", "test", ...args]);
}

function isSymlink(path: string): boolean {
  return lstatSync(path).isSymbolicLink();
}

function writeLegacyLock(skills: Record<string, { source: string }>): void {
  mkdirSync(join(mocks.home, ".agents"), { recursive: true });
  writeFileSync(lockPath(), JSON.stringify({ version: 3, skills }));
}

beforeEach(() => {
  mocks.symlinkError = null;
  mocks.rmError = null;
  tempDir = mkdtempSync(join(tmpdir(), "dosu-skill-test-"));
  mocks.home = join(tempDir, "home");
  mkdirSync(mocks.home, { recursive: true });
  origXDG = process.env.XDG_CONFIG_HOME;
  process.env.XDG_CONFIG_HOME = join(tempDir, "xdg");
  delete process.env.CLAUDE_CONFIG_DIR;

  logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
  errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
  exitSpy = vi.spyOn(process, "exit").mockImplementation((() => {
    throw new Error("exit");
  }) as never);
});

afterEach(() => {
  mocks.symlinkError = null;
  mocks.rmError = null;
  logSpy.mockRestore();
  errorSpy.mockRestore();
  exitSpy.mockRestore();
  if (origXDG !== undefined) {
    process.env.XDG_CONFIG_HOME = origXDG;
  } else {
    delete process.env.XDG_CONFIG_HOME;
  }
  rmSync(tempDir, { recursive: true, force: true });
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

describe("installBundledSkills", () => {
  it("writes every bundled skill to the universal directory", () => {
    const result = installBundledSkills(["cursor"]);

    expect(result).toEqual({
      success: true,
      version: "9.9.9",
      paths: [join(universal(), "dosu"), join(universal(), "read-knowledge-impact")],
    });
    expect(readFileSync(join(universal(), "dosu", "SKILL.md"), "utf-8")).toBe("# dosu\n");
    expect(readFileSync(join(universal(), "dosu", "references", "commands.md"), "utf-8")).toBe(
      "commands\n",
    );
    expect(existsSync(join(universal(), "read-knowledge-impact", "scripts", "run.py"))).toBe(true);
  });

  it("preserves the executable bit on scripts", () => {
    installBundledSkills(["codex"]);
    const script = statSync(join(universal(), "read-knowledge-impact", "scripts", "run.py"));
    expect(script.mode & 0o111).not.toBe(0);
    const doc = statSync(join(universal(), "dosu", "SKILL.md"));
    expect(doc.mode & 0o111).toBe(0);
  });

  it("symlinks Claude Code and Windsurf directories at the universal copy", () => {
    const result = installBundledSkills(["claude-code", "windsurf", "cursor"]);

    for (const dir of [claude(), windsurf()]) {
      for (const name of ["dosu", "read-knowledge-impact"]) {
        const link = join(dir, name);
        expect(isSymlink(link)).toBe(true);
        // Relative, like the legacy `skills` CLI wrote, so a moved $HOME keeps working.
        expect(readlinkSync(link)).toBe(relative(dir, join(universal(), name)));
        expect(readFileSync(join(link, "SKILL.md"), "utf-8")).toBeTruthy();
      }
    }
    expect(result.paths).toContain(join(claude(), "dosu"));
    expect(result.paths).toContain(join(windsurf(), "read-knowledge-impact"));
  });

  it("honors CLAUDE_CONFIG_DIR for the Claude Code link", () => {
    const custom = join(tempDir, "custom-claude");
    vi.stubEnv("CLAUDE_CONFIG_DIR", custom);

    installBundledSkills(["claude-code"]);

    expect(isSymlink(join(custom, "skills", "dosu"))).toBe(true);
    expect(existsSync(join(claude(), "dosu"))).toBe(false);
  });

  it("replaces a stale copy wholesale so removed files do not linger", () => {
    mkdirSync(join(universal(), "dosu"), { recursive: true });
    writeFileSync(join(universal(), "dosu", "old.md"), "stale");
    writeFileSync(join(universal(), "dosu", "SKILL.md"), "stale");

    installBundledSkills(["cursor"]);

    expect(existsSync(join(universal(), "dosu", "old.md"))).toBe(false);
    expect(readFileSync(join(universal(), "dosu", "SKILL.md"), "utf-8")).toBe("# dosu\n");
  });

  it("replaces a real directory left by the legacy installer with a symlink", () => {
    mkdirSync(join(claude(), "dosu"), { recursive: true });
    writeFileSync(join(claude(), "dosu", "SKILL.md"), "legacy copy");

    installBundledSkills(["claude-code"]);

    expect(isSymlink(join(claude(), "dosu"))).toBe(true);
    expect(readFileSync(join(claude(), "dosu", "SKILL.md"), "utf-8")).toBe("# dosu\n");
  });

  it("records the bundle version and the union of agents installed so far", () => {
    installBundledSkills(["claude-code"]);
    installBundledSkills(["cursor"]);

    const state = readSkillInstallState();
    expect(state?.version).toBe("9.9.9");
    expect(state?.agents).toEqual(["claude-code", "cursor"]);
    expect(typeof state?.installedAt).toBe("number");
    expect(statSync(statePath()).mode & 0o777).toBe(0o600);
  });

  it("does nothing for agents without skill support", () => {
    const result = installBundledSkills(["promptscript"]);

    expect(result).toEqual({ success: true });
    expect(existsSync(universal())).toBe(false);
    expect(readSkillInstallState()).toBeNull();
  });

  it("drops the legacy skills-CLI lock entries so `npx skills update` cannot clobber the bundle", () => {
    writeLegacyLock({
      dosu: { source: "dosu-ai/dosu-skill" },
      "read-knowledge-impact": { source: "dosu-ai/dosu-skill" },
      "web-design": { source: "vercel-labs/agent-skills" },
    });

    installBundledSkills(["cursor"]);

    const lock = JSON.parse(readFileSync(lockPath(), "utf-8"));
    expect(Object.keys(lock.skills)).toEqual(["web-design"]);
  });

  it("removes legacy Dosu skills the bundle no longer ships", () => {
    writeLegacyLock({ "log-to-dosu-knowledge": { source: "dosu-ai/dosu-skill" } });
    mkdirSync(join(universal(), "log-to-dosu-knowledge"), { recursive: true });
    writeFileSync(join(universal(), "log-to-dosu-knowledge", "SKILL.md"), "old");
    mkdirSync(claude(), { recursive: true });
    writeFileSync(join(claude(), "log-to-dosu-knowledge"), "dangling-link-stand-in");

    installBundledSkills(["claude-code"]);

    expect(existsSync(join(universal(), "log-to-dosu-knowledge"))).toBe(false);
    expect(existsSync(join(claude(), "log-to-dosu-knowledge"))).toBe(false);
  });

  it("tolerates a corrupt legacy lock file", () => {
    mkdirSync(join(mocks.home, ".agents"), { recursive: true });
    writeFileSync(lockPath(), "NOT JSON{{{");

    expect(installBundledSkills(["cursor"]).success).toBe(true);
  });

  it("ignores a legacy lock without a skills map", () => {
    mkdirSync(join(mocks.home, ".agents"), { recursive: true });
    writeFileSync(lockPath(), JSON.stringify({ version: 3 }));

    expect(installBundledSkills(["cursor"]).success).toBe(true);
    expect(readFileSync(lockPath(), "utf-8")).toBe(JSON.stringify({ version: 3 }));
  });

  it("deletes the legacy SHA cache the GitHub-polling checker used", () => {
    const legacyCache = join(tempDir, "xdg", "dosu-cli", "skill-update-check.json");
    mkdirSync(join(tempDir, "xdg", "dosu-cli"), { recursive: true });
    writeFileSync(legacyCache, "{}");

    installBundledSkills(["cursor"]);

    expect(existsSync(legacyCache)).toBe(false);
  });

  it("reports failure when the universal directory cannot be written", () => {
    mkdirSync(join(mocks.home, ".agents"), { recursive: true });
    writeFileSync(universal(), "a file where the skills directory should be");

    const result = installBundledSkills(["cursor"]);

    expect(result.success).toBe(false);
    expect(readSkillInstallState()).toBeNull();
  });

  it("falls back to copying when the symlink cannot be created", () => {
    mocks.symlinkError = new Error("EPERM");

    const result = installBundledSkills(["claude-code"]);

    expect(result.success).toBe(true);
    expect(isSymlink(join(claude(), "dosu"))).toBe(false);
    expect(readFileSync(join(claude(), "dosu", "SKILL.md"), "utf-8")).toBe("# dosu\n");
  });
});

describe("installSkill", () => {
  it("maps MCP provider IDs onto skill agents", async () => {
    const result = await installSkill(["claude", "vscode"]);

    expect(result.success).toBe(true);
    expect(isSymlink(join(claude(), "dosu"))).toBe(true);
    expect(readSkillInstallState()?.agents).toEqual(["claude-code", "github-copilot"]);
  });

  it("installs for every supported agent when no providers are given", async () => {
    await installSkill();

    expect(isSymlink(join(claude(), "dosu"))).toBe(true);
    expect(isSymlink(join(windsurf(), "dosu"))).toBe(true);
    expect(readSkillInstallState()?.agents).toHaveLength(10);
  });

  it("does not broaden an unsupported provider into an all-agent install", async () => {
    const result = await installSkill(["manual"]);

    expect(result).toEqual({ success: true });
    expect(existsSync(universal())).toBe(false);
  });
});

describe("removeSkills", () => {
  it("removes universal copies, agent links, and the install state", () => {
    installBundledSkills(["claude-code", "windsurf"]);

    const removed = removeSkills();

    expect(removed).toEqual(
      expect.arrayContaining([
        join(universal(), "dosu"),
        join(universal(), "read-knowledge-impact"),
        join(claude(), "dosu"),
        join(windsurf(), "read-knowledge-impact"),
      ]),
    );
    expect(existsSync(join(universal(), "dosu"))).toBe(false);
    expect(existsSync(join(claude(), "dosu"))).toBe(false);
    expect(readSkillInstallState()).toBeNull();
  });

  it("also removes skills the legacy installer attributed to the Dosu repo", () => {
    writeLegacyLock({
      "log-to-dosu-knowledge": { source: "dosu-ai/dosu-skill" },
      "web-design": { source: "vercel-labs/agent-skills" },
    });
    mkdirSync(join(universal(), "log-to-dosu-knowledge"), { recursive: true });
    mkdirSync(join(universal(), "web-design"), { recursive: true });

    removeSkills();

    expect(existsSync(join(universal(), "log-to-dosu-knowledge"))).toBe(false);
    expect(existsSync(join(universal(), "web-design"))).toBe(true);
    expect(Object.keys(JSON.parse(readFileSync(lockPath(), "utf-8")).skills)).toEqual([
      "web-design",
    ]);
  });

  it("returns an empty list when nothing is installed", () => {
    expect(removeSkills()).toEqual([]);
  });
});

describe("skill command", () => {
  it("install writes the bundle and prints the paths", async () => {
    await run("install");

    expect(existsSync(join(universal(), "dosu", "SKILL.md"))).toBe(true);
    expect(allOutput()).toContain("installed successfully");
    expect(allOutput()).toContain(join(universal(), "dosu"));
  });

  it("install exits non-zero on failure", async () => {
    mkdirSync(join(mocks.home, ".agents"), { recursive: true });
    writeFileSync(universal(), "blocker");

    await expect(run("install")).rejects.toThrow("exit");
    expect(allErrors()).toContain("Failed to install skill");
  });

  it("remove reports when nothing is installed", async () => {
    await run("remove");
    expect(allOutput()).toContain("No Dosu skills are installed");
  });

  it("remove deletes installed skills and prints success", async () => {
    installBundledSkills(["cursor"]);

    await run("remove");

    expect(existsSync(join(universal(), "dosu"))).toBe(false);
    expect(allOutput()).toContain("removed");
  });

  it("remove exits non-zero when deletion fails", async () => {
    installBundledSkills(["cursor"]);
    mocks.rmError = new Error("EACCES");

    await expect(run("remove")).rejects.toThrow("exit");
    expect(allErrors()).toContain("Failed to remove skills");
  });

  it("update rewrites the bundle and points at dosu upgrade for newer content", async () => {
    mkdirSync(join(universal(), "dosu"), { recursive: true });
    writeFileSync(join(universal(), "dosu", "SKILL.md"), "stale");

    await run("update");

    expect(readFileSync(join(universal(), "dosu", "SKILL.md"), "utf-8")).toBe("# dosu\n");
    expect(allOutput()).toContain("updated");
    expect(allOutput()).toContain("dosu upgrade");
  });

  it("update exits non-zero on failure", async () => {
    mkdirSync(join(mocks.home, ".agents"), { recursive: true });
    writeFileSync(universal(), "blocker");

    await expect(run("update")).rejects.toThrow("exit");
    expect(allErrors()).toContain("Failed to update skill");
  });
});

describe("provider helpers", () => {
  it("maps provider aliases and de-duplicates shared skill agents", () => {
    expect(
      skillAgentIDsForProviders(["vscode", "copilot", "cline", "cline-cli", "manual"]),
    ).toEqual(["github-copilot", "cline"]);
  });

  it("reports the Claude symlink target and respects CLAUDE_CONFIG_DIR", () => {
    vi.stubEnv("CLAUDE_CONFIG_DIR", "/tmp/custom-claude");

    expect(skillInstallTargetForProvider("claude")).toEqual({
      path: "/tmp/custom-claude/skills/dosu",
      symlink: true,
    });
  });

  it("reports the universal skill target for Codex", () => {
    expect(skillInstallTargetForProvider("codex")).toEqual({
      path: join(universal(), "dosu"),
      symlink: false,
    });
  });

  it("reports the Windsurf symlink target", () => {
    expect(skillInstallTargetForProvider("windsurf")).toEqual({
      path: join(windsurf(), "dosu"),
      symlink: true,
    });
  });

  it("returns null for a provider without skill support", () => {
    expect(skillInstallTargetForProvider("manual")).toBeNull();
  });
});

describe("readSkillInstallState", () => {
  it("returns null for a malformed state file", () => {
    mkdirSync(join(tempDir, "xdg", "dosu-cli"), { recursive: true });
    writeFileSync(statePath(), JSON.stringify({ version: 1, agents: "claude-code" }));
    expect(readSkillInstallState()).toBeNull();

    writeFileSync(statePath(), "NOT JSON{{{");
    expect(readSkillInstallState()).toBeNull();
  });
});
