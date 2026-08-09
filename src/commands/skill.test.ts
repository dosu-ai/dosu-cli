import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mockExecSync = vi.fn();
const mockExec = vi.fn();
vi.mock("node:child_process", () => ({
  exec: (...args: unknown[]) => mockExec(...args),
  execSync: (...args: unknown[]) => mockExecSync(...args),
}));

import {
  installSkill,
  projectSkillInstallTargetsForProviders,
  SKILLS_CLI_VERSION,
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

beforeEach(() => {
  mockExec.mockReset();
  mockExec.mockImplementation((...args: unknown[]) => {
    const callback = args.at(-1) as (error: Error | null) => void;
    callback(null);
  });
  mockExecSync.mockReset();
  logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
  errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
  exitSpy = vi.spyOn(process, "exit").mockImplementation((() => {
    throw new Error("exit");
  }) as never);

  // Isolate cache writes to a temp dir so they don't pollute $HOME
  origXDG = process.env.XDG_CONFIG_HOME;
  tempDir = mkdtempSync(join(tmpdir(), "dosu-skill-test-"));
  process.env.XDG_CONFIG_HOME = tempDir;

  // Default: fetch returns a SHA
  vi.stubGlobal(
    "fetch",
    vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ sha: "test-sha" }),
    }),
  );
});

afterEach(() => {
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

describe("skill install", () => {
  it("passes every agent through the installer's single variadic agent flag", async () => {
    await run("install");
    expect(mockExecSync).toHaveBeenCalledWith(
      [
        `npx -y skills@${SKILLS_CLI_VERSION} add dosu-ai/dosu-skill -g`,
        "-a claude-code cursor gemini-cli codex windsurf",
        "zed cline github-copilot opencode antigravity",
        "-s dosu -y",
      ].join(" "),
      {
        stdio: "inherit",
      },
    );
  });

  it("does not let skills auto-target PromptScript", async () => {
    await run("install");
    const command = String(mockExecSync.mock.calls[0][0]);
    expect(command).toContain("-a claude-code");
    expect(command).not.toContain("promptscript");
  });

  it("prints success message", async () => {
    await run("install");
    expect(allOutput()).toContain("installed successfully");
  });

  it("exits with error when execSync throws", async () => {
    mockExecSync.mockImplementation(() => {
      throw new Error("command failed");
    });
    await expect(run("install")).rejects.toThrow("exit");
    expect(allErrors()).toContain("Failed to install skill");
  });
});

describe("skill remove", () => {
  it("runs npx skills remove with correct args", async () => {
    await run("remove");
    expect(mockExecSync).toHaveBeenCalledWith(
      `npx -y skills@${SKILLS_CLI_VERSION} remove -g -s dosu -y`,
      {
        stdio: "inherit",
      },
    );
  });

  it("prints success message", async () => {
    await run("remove");
    expect(allOutput()).toContain("removed");
  });

  it("exits with error when execSync throws", async () => {
    mockExecSync.mockImplementation(() => {
      throw new Error("command failed");
    });
    await expect(run("remove")).rejects.toThrow("exit");
    expect(allErrors()).toContain("Failed to remove skill");
  });
});

describe("skill update", () => {
  it("reinstalls via npx skills add (update can't follow repo-layout moves)", async () => {
    await run("update");
    expect(mockExecSync).toHaveBeenCalledWith(
      expect.stringContaining(`npx -y skills@${SKILLS_CLI_VERSION} add dosu-ai/dosu-skill -g`),
      { stdio: "inherit" },
    );
    expect(mockExecSync).not.toHaveBeenCalledWith(
      expect.stringContaining("npx skills update"),
      expect.anything(),
    );
  });

  it("prints success message", async () => {
    await run("update");
    expect(allOutput()).toContain("updated");
  });

  it("exits with error when execSync throws", async () => {
    mockExecSync.mockImplementation(() => {
      throw new Error("command failed");
    });
    await expect(run("update")).rejects.toThrow("exit");
    expect(allErrors()).toContain("Failed to update skill");
  });

  it("refreshes installedSha in cache after successful update", async () => {
    await run("update");

    const cachePath = join(tempDir, "dosu-cli", "skill-update-check.json");
    const cache = JSON.parse(readFileSync(cachePath, "utf-8"));
    expect(cache.installedSha).toBe("test-sha");
    expect(cache.latestSha).toBe("test-sha");
  });

  it("does not write cache when fetch fails during refresh", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: false }));
    await run("update");
    // npx command still succeeded, we just didn't learn a SHA
    expect(allOutput()).toContain("updated");
  });
});

describe("installSkill helper", () => {
  function writeOwnedProjectSkill(
    projectRoot: string,
    relativeTarget = ".agents/skills/dosu",
  ): string {
    const target = join(projectRoot, relativeTarget);
    const content = "---\nname: dosu\ndescription: Dosu knowledge\n---\nUse Dosu.\n";
    mkdirSync(target, { recursive: true });
    writeFileSync(join(target, "SKILL.md"), content);
    const computedHash = createHash("sha256").update("SKILL.md").update(content).digest("hex");
    writeFileSync(
      join(projectRoot, "skills-lock.json"),
      JSON.stringify({
        version: 1,
        skills: {
          dosu: {
            source: "dosu-ai/dosu-skill",
            sourceType: "github",
            skillPath: "skills/dosu/SKILL.md",
            computedHash,
          },
        },
      }),
    );
    return computedHash;
  }

  it("installs only for the selected MCP providers", async () => {
    const result = await installSkill(["claude", "codex"]);

    expect(result.success).toBe(true);
    expect(mockExecSync).toHaveBeenCalledWith(
      `npx -y skills@${SKILLS_CLI_VERSION} add dosu-ai/dosu-skill -g -a claude-code codex -s dosu -y`,
      { stdio: "inherit" },
    );
  });

  it("installs selected skills into the project when a project root is provided", async () => {
    const projectRoot = join(tempDir, "repo");
    mkdirSync(projectRoot);
    const result = await installSkill(["claude", "codex"], { projectRoot });

    expect(result.success).toBe(true);
    expect(mockExecSync).toHaveBeenCalledWith(
      `npx -y skills@${SKILLS_CLI_VERSION} add dosu-ai/dosu-skill -a claude-code codex -s dosu -y`,
      { stdio: "inherit", cwd: projectRoot },
    );
  });

  it("installs the Factory skill with the pinned Droid agent ID", async () => {
    const projectRoot = join(tempDir, "repo");
    mkdirSync(projectRoot);

    const result = await installSkill(["factory"], { projectRoot });

    expect(result.success).toBe(true);
    expect(mockExecSync).toHaveBeenCalledWith(
      `npx -y skills@${SKILLS_CLI_VERSION} add dosu-ai/dosu-skill -a droid -s dosu -y`,
      { stdio: "inherit", cwd: projectRoot },
    );
  });

  it("refuses a project skill parent symlink before invoking the third-party installer", async () => {
    const projectRoot = join(tempDir, "repo");
    const outside = join(tempDir, "outside");
    mkdirSync(projectRoot);
    mkdirSync(outside);
    symlinkSync(outside, join(projectRoot, ".agents"));

    await expect(installSkill(["codex"], { projectRoot })).rejects.toThrow(/symbolic link/i);
    expect(mockExecSync).not.toHaveBeenCalled();
  });

  it("refuses dangling project skill and lock symlinks before invoking the installer", async () => {
    const projectRoot = join(tempDir, "repo");
    mkdirSync(join(projectRoot, ".agents", "skills"), { recursive: true });
    symlinkSync(join(tempDir, "missing-skill"), join(projectRoot, ".agents", "skills", "dosu"));

    await expect(installSkill(["codex"], { projectRoot })).rejects.toThrow(/ownership/i);
    expect(mockExecSync).not.toHaveBeenCalled();

    rmSync(join(projectRoot, ".agents", "skills", "dosu"));
    symlinkSync(join(tempDir, "missing-lock"), join(projectRoot, "skills-lock.json"));
    await expect(installSkill(["codex"], { projectRoot })).rejects.toThrow(/symbolic link/i);
    expect(mockExecSync).not.toHaveBeenCalled();
  });

  it("refuses to overwrite a foreign project skill directory without a Dosu lock receipt", async () => {
    const projectRoot = join(tempDir, "repo");
    const target = join(projectRoot, ".agents", "skills", "dosu");
    mkdirSync(target, { recursive: true });
    writeFileSync(join(target, "SKILL.md"), "user-owned\n");

    await expect(installSkill(["codex"], { projectRoot })).rejects.toThrow(/ownership/i);
    expect(readFileSync(join(target, "SKILL.md"), "utf8")).toBe("user-owned\n");
    expect(mockExecSync).not.toHaveBeenCalled();
  });

  it("refuses a foreign Dosu lock entry even when the target directory is absent", async () => {
    const projectRoot = join(tempDir, "repo");
    mkdirSync(projectRoot);
    writeFileSync(
      join(projectRoot, "skills-lock.json"),
      JSON.stringify({
        version: 1,
        skills: {
          dosu: {
            source: "someone-else/dosu",
            sourceType: "github",
            skillPath: "skills/dosu/SKILL.md",
            computedHash: "a".repeat(64),
          },
        },
      }),
    );

    await expect(installSkill(["codex"], { projectRoot })).rejects.toThrow(/ownership/i);
    expect(mockExecSync).not.toHaveBeenCalled();
  });

  it("allows an exact lock-backed project skill to be refreshed", async () => {
    const projectRoot = join(tempDir, "repo");
    mkdirSync(projectRoot);
    writeOwnedProjectSkill(projectRoot);

    const result = await installSkill(["codex"], { projectRoot });

    expect(result.success).toBe(true);
    expect(mockExecSync).toHaveBeenCalledOnce();
  });

  it("allows the actual Claude-only direct project layout", async () => {
    const projectRoot = join(tempDir, "repo");
    mkdirSync(projectRoot);
    writeOwnedProjectSkill(projectRoot, ".claude/skills/dosu");

    const result = await installSkill(["claude"], { projectRoot });

    expect(result.success).toBe(true);
    expect(mockExecSync).toHaveBeenCalledOnce();
  });

  it("allows the actual mixed canonical plus Claude symlink layout", async () => {
    const projectRoot = join(tempDir, "repo");
    mkdirSync(projectRoot);
    writeOwnedProjectSkill(projectRoot);
    const claudeParent = join(projectRoot, ".claude", "skills");
    mkdirSync(claudeParent, { recursive: true });
    symlinkSync("../../.agents/skills/dosu", join(claudeParent, "dosu"), "dir");

    const result = await installSkill(["claude", "codex"], { projectRoot });

    expect(result.success).toBe(true);
    expect(mockExecSync).toHaveBeenCalledOnce();
  });

  it("allows a Claude-only refresh after an owned mixed-layout install", async () => {
    const projectRoot = join(tempDir, "repo");
    mkdirSync(projectRoot);
    writeOwnedProjectSkill(projectRoot);
    const claudeParent = join(projectRoot, ".claude", "skills");
    mkdirSync(claudeParent, { recursive: true });
    symlinkSync("../../.agents/skills/dosu", join(claudeParent, "dosu"), "dir");

    const result = await installSkill(["claude"], { projectRoot });

    expect(result.success).toBe(true);
    expect(mockExecSync).toHaveBeenCalledWith(
      `npx -y skills@${SKILLS_CLI_VERSION} add dosu-ai/dosu-skill -a claude-code -s dosu -y`,
      { stdio: "inherit", cwd: projectRoot },
    );
  });

  it("maps provider aliases and de-duplicates shared skill agents", () => {
    expect(
      skillAgentIDsForProviders(["vscode", "copilot", "cline", "cline-cli", "manual"]),
    ).toEqual(["github-copilot", "cline"]);
    expect(skillAgentIDsForProviders(["factory", "factory"])).toEqual(["droid"]);
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
      path: join(homedir(), ".agents", "skills", "dosu"),
      symlink: false,
    });
  });

  it("reports project-local adapter paths when a project root is provided", () => {
    expect(skillInstallTargetForProvider("claude", "/repo")).toEqual({
      path: "/repo/.claude/skills/dosu",
      symlink: false,
    });
    expect(skillInstallTargetForProvider("codex", "/repo")).toEqual({
      path: "/repo/.agents/skills/dosu",
      symlink: false,
    });
    expect(skillInstallTargetForProvider("factory", "/repo")).toEqual({
      path: "/repo/.factory/skills/dosu",
      symlink: false,
    });
  });

  it("models the pinned Factory-only and mixed Droid project layouts", () => {
    expect(projectSkillInstallTargetsForProviders(["factory"], "/repo")).toEqual([
      { path: "/repo/.factory/skills/dosu", symlink: false },
    ]);
    expect(projectSkillInstallTargetsForProviders(["factory", "codex"], "/repo")).toEqual([
      { path: "/repo/.agents/skills/dosu", symlink: false },
      { path: "/repo/.factory/skills/dosu", symlink: true },
    ]);
  });

  it("reports the Windsurf symlink target", () => {
    expect(skillInstallTargetForProvider("windsurf")).toEqual({
      path: join(homedir(), ".codeium", "windsurf", "skills", "dosu"),
      symlink: true,
    });
  });

  it("returns null for a provider without skill support", () => {
    expect(skillInstallTargetForProvider("manual")).toBeNull();
  });

  it("keeps the installer quiet for agent-mediated setup", async () => {
    await installSkill(["claude"], { quiet: true });

    expect(mockExec).toHaveBeenCalledWith(
      expect.any(String),
      { windowsHide: true },
      expect.any(Function),
    );
    expect(mockExecSync).not.toHaveBeenCalled();
  });

  it("returns failure when the async quiet installer fails", async () => {
    mockExec.mockImplementation((...args: unknown[]) => {
      const callback = args.at(-1) as (error: Error | null) => void;
      callback(new Error("command failed"));
    });

    const result = await installSkill(["claude"], { quiet: true });

    expect(result.success).toBe(false);
  });

  it("does not broaden an unsupported provider into an all-agent install", async () => {
    const result = await installSkill(["manual"]);

    expect(result.success).toBe(true);
    expect(mockExecSync).not.toHaveBeenCalled();
  });

  it("writes cache with SHA on success", async () => {
    const result = await installSkill();
    expect(result.success).toBe(true);
    expect(result.sha).toBe("test-sha");

    const cachePath = join(tempDir, "dosu-cli", "skill-update-check.json");
    const cache = JSON.parse(readFileSync(cachePath, "utf-8"));
    expect(cache.installedSha).toBe("test-sha");
    expect(cache.latestSha).toBe("test-sha");
    expect(typeof cache.lastCheck).toBe("number");
  });

  it("returns success without SHA when fetch fails", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: false }));
    const result = await installSkill();
    expect(result.success).toBe(true);
    expect(result.sha).toBeUndefined();
  });

  it("returns success without SHA when fetch throws", async () => {
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("network error")));
    const result = await installSkill();
    expect(result.success).toBe(true);
    expect(result.sha).toBeUndefined();
  });

  it("returns failure when execSync throws", async () => {
    mockExecSync.mockImplementation(() => {
      throw new Error("command failed");
    });
    const result = await installSkill();
    expect(result.success).toBe(false);
    expect(result.sha).toBeUndefined();
  });
});
