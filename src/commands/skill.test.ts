import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { homedir, tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mockExecSync = vi.fn();
const mockExec = vi.fn();
vi.mock("node:child_process", () => ({
  exec: (...args: unknown[]) => mockExec(...args),
  execSync: (...args: unknown[]) => mockExecSync(...args),
}));

import {
  installSkill,
  removeGlobalSkillQuietly,
  skillAgentIDsForProviders,
  skillCommand,
  skillInstallTargetForProvider,
  verifiedProjectSkillProviderIDs,
} from "./skill";

let logSpy: ReturnType<typeof vi.spyOn>;
let errorSpy: ReturnType<typeof vi.spyOn>;
// biome-ignore lint/suspicious/noExplicitAny: process.exit mock type mismatch
let exitSpy: any;

let tempDir: string;
let origHome: string | undefined;
let origXDG: string | undefined;
let origXDGState: string | undefined;

function writeDosuSkill(path: string): void {
  mkdirSync(path, { recursive: true });
  writeFileSync(join(path, "SKILL.md"), "---\nname: dosu\n---\n# Using the Dosu CLI\n");
}

function writeOwnedSkillLock(path: string): void {
  mkdirSync(join(path, ".."), { recursive: true });
  writeFileSync(
    path,
    JSON.stringify({ version: 3, skills: { dosu: { source: "dosu-ai/dosu-skill" } } }),
  );
}

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
  origXDGState = process.env.XDG_STATE_HOME;
  origHome = process.env.HOME;
  tempDir = realpathSync(mkdtempSync(join(tmpdir(), "dosu-skill-test-")));
  process.env.HOME = tempDir;
  process.env.XDG_CONFIG_HOME = tempDir;
  process.env.XDG_STATE_HOME = tempDir;

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
  if (origXDGState !== undefined) {
    process.env.XDG_STATE_HOME = origXDGState;
  } else {
    delete process.env.XDG_STATE_HOME;
  }
  if (origHome !== undefined) {
    process.env.HOME = origHome;
  } else {
    delete process.env.HOME;
  }
  rmSync(tempDir, { recursive: true, force: true });
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

describe("skill install", () => {
  it("runs npx skills add with correct args", async () => {
    await run("install");
    expect(mockExecSync).toHaveBeenCalledWith(
      [
        "npx skills add dosu-ai/dosu-skill -g",
        "-a claude-code -a cursor -a gemini-cli -a codex -a windsurf",
        "-a zed -a cline -a github-copilot -a opencode -a antigravity",
        '-s "*" -y',
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

describe("quiet global skill cleanup", () => {
  it("removes only the historical global Dosu skill", async () => {
    writeOwnedSkillLock(join(tempDir, "skills", ".skill-lock.json"));
    const canonical = join(tempDir, ".agents", "skills", "dosu");
    writeDosuSkill(canonical);
    mkdirSync(join(tempDir, ".claude", "skills"), { recursive: true });
    symlinkSync(canonical, join(tempDir, ".claude", "skills", "dosu"));

    await expect(removeGlobalSkillQuietly(["claude", "cursor"])).resolves.toBe(true);

    expect(mockExec).toHaveBeenCalledWith(
      "npx -y skills@1.5.22 remove -g -a claude-code -s dosu -y",
      { windowsHide: true },
      expect.any(Function),
    );
  });

  it("silently reports failure", async () => {
    writeOwnedSkillLock(join(tempDir, "skills", ".skill-lock.json"));
    const canonical = join(tempDir, ".agents", "skills", "dosu");
    writeDosuSkill(canonical);
    mkdirSync(join(tempDir, ".claude", "skills"), { recursive: true });
    symlinkSync(canonical, join(tempDir, ".claude", "skills", "dosu"));
    mockExec.mockImplementation((...args: unknown[]) => {
      const callback = args.at(-1) as (error: Error | null) => void;
      callback(new Error("remove failed"));
    });

    await expect(removeGlobalSkillQuietly(["claude"])).resolves.toBe(false);
  });

  it("preserves missing, malformed, and foreign global skills", async () => {
    await expect(removeGlobalSkillQuietly(["claude"])).resolves.toBe(false);

    const lockDir = join(tempDir, "skills");
    mkdirSync(lockDir, { recursive: true });
    const lockPath = join(lockDir, ".skill-lock.json");
    writeFileSync(lockPath, "not-json");
    await expect(removeGlobalSkillQuietly(["claude"])).resolves.toBe(false);

    writeFileSync(
      lockPath,
      JSON.stringify({ version: 3, skills: { dosu: { source: "someone-else/dosu" } } }),
    );
    await expect(removeGlobalSkillQuietly(["claude"])).resolves.toBe(false);

    expect(mockExec).not.toHaveBeenCalled();
  });

  it("does not run for a provider without a project skill target", async () => {
    await expect(removeGlobalSkillQuietly(["manual"])).resolves.toBe(false);

    expect(mockExec).not.toHaveBeenCalled();
  });

  it("preserves universal global skills shared by other agents", async () => {
    writeOwnedSkillLock(join(tempDir, "skills", ".skill-lock.json"));
    writeDosuSkill(join(tempDir, ".agents", "skills", "dosu"));

    await expect(removeGlobalSkillQuietly(["cursor", "codex"])).resolves.toBe(false);

    expect(mockExec).not.toHaveBeenCalled();
  });

  it("preserves a foreign canonical skill even when an isolated target is owned", async () => {
    writeOwnedSkillLock(join(tempDir, "skills", ".skill-lock.json"));
    const canonical = join(tempDir, ".agents", "skills", "dosu");
    mkdirSync(canonical, { recursive: true });
    writeFileSync(join(canonical, "SKILL.md"), "---\nname: dosu\n---\n# Foreign skill\n");
    writeDosuSkill(join(tempDir, ".claude", "skills", "dosu"));

    await expect(removeGlobalSkillQuietly(["claude"])).resolves.toBe(false);

    rmSync(canonical, { recursive: true });
    symlinkSync(join(tempDir, "missing-canonical"), canonical);
    await expect(removeGlobalSkillQuietly(["claude"])).resolves.toBe(false);

    expect(mockExec).not.toHaveBeenCalled();
  });

  it("preserves a global skill behind a symlinked parent or lock path", async () => {
    const outside = join(tempDir, "outside");
    writeDosuSkill(join(outside, "skills", "dosu"));
    symlinkSync(outside, join(tempDir, ".agents"));
    writeOwnedSkillLock(join(tempDir, "skills", ".skill-lock.json"));

    await expect(removeGlobalSkillQuietly(["cursor"])).resolves.toBe(false);

    rmSync(join(tempDir, ".agents"));
    mkdirSync(join(tempDir, ".agents"));
    const outsideLock = join(tempDir, "outside-lock.json");
    writeOwnedSkillLock(outsideLock);
    rmSync(join(tempDir, "skills", ".skill-lock.json"));
    symlinkSync(outsideLock, join(tempDir, "skills", ".skill-lock.json"));

    await expect(removeGlobalSkillQuietly(["cursor"])).resolves.toBe(false);
    expect(mockExec).not.toHaveBeenCalled();
  });
});

describe("skill remove", () => {
  /** Make `npx skills list -g --json` resolve to the given inventory. */
  function stubInventory(entries: unknown[]): void {
    mockExecSync.mockImplementation((command: string) =>
      command.includes("skills list") ? JSON.stringify(entries) : undefined,
    );
  }

  it("removes every skill installed from the Dosu repo", async () => {
    stubInventory([
      { name: "dosu", source: "dosu-ai/dosu-skill" },
      { name: "dosu-review", source: "dosu-ai/dosu-skill" },
    ]);
    await run("remove");
    expect(mockExecSync).toHaveBeenCalledWith("npx skills remove -g dosu dosu-review -y", {
      stdio: "inherit",
    });
  });

  it("leaves skills from other sources alone", async () => {
    stubInventory([
      { name: "dosu", source: "dosu-ai/dosu-skill" },
      { name: "web-design", source: "vercel-labs/agent-skills" },
      { name: "local-skill", source: null },
    ]);
    await run("remove");
    expect(mockExecSync).toHaveBeenCalledWith("npx skills remove -g dosu -y", {
      stdio: "inherit",
    });
  });

  it("skips names that are unsafe to interpolate into a shell command", async () => {
    stubInventory([
      { name: "dosu", source: "dosu-ai/dosu-skill" },
      { name: "evil; rm -rf /", source: "dosu-ai/dosu-skill" },
    ]);
    await run("remove");
    expect(mockExecSync).toHaveBeenCalledWith("npx skills remove -g dosu -y", {
      stdio: "inherit",
    });
  });

  // `skills list` echoes the front-matter name without validating it, and
  // `skills remove --all` deletes every skill from every source.
  it("skips flag-shaped names so they cannot be re-parsed as options", async () => {
    stubInventory([
      { name: "dosu", source: "dosu-ai/dosu-skill" },
      { name: "--all", source: "dosu-ai/dosu-skill" },
    ]);
    await run("remove");
    expect(mockExecSync).toHaveBeenCalledWith("npx skills remove -g dosu -y", {
      stdio: "inherit",
    });
  });

  it("does nothing when the inventory holds no skills of ours", async () => {
    stubInventory([{ name: "web-design", source: "vercel-labs/agent-skills" }]);
    await run("remove");
    expect(mockExecSync).not.toHaveBeenCalledWith(
      expect.stringContaining("skills remove"),
      expect.anything(),
    );
    expect(allOutput()).toContain("No skills from dosu-ai/dosu-skill are installed");
  });

  it("stops the update notice by forgetting the installed SHA", async () => {
    const cachePath = join(tempDir, "dosu-cli", "skill-update-check.json");
    mkdirSync(dirname(cachePath), { recursive: true });
    writeFileSync(
      cachePath,
      JSON.stringify({ lastCheck: 1, latestSha: "new-sha", installedSha: "old-sha" }),
    );

    stubInventory([{ name: "dosu", source: "dosu-ai/dosu-skill" }]);
    await run("remove");

    const cache = JSON.parse(readFileSync(cachePath, "utf-8"));
    expect(cache.installedSha).toBe("");
    expect(cache.latestSha).toBe("new-sha");
  });

  it("treats a non-array inventory as unreadable", async () => {
    stubInventory({ unexpected: "shape" } as unknown as unknown[]);
    await run("remove");
    expect(mockExecSync).toHaveBeenCalledWith("npx skills remove -g dosu -y", {
      stdio: "inherit",
    });
  });

  it("falls back to the known skill when the inventory is unreadable", async () => {
    mockExecSync.mockImplementation((command: string) => {
      if (command.includes("skills list")) throw new Error("npx unavailable");
      return undefined;
    });
    await run("remove");
    expect(mockExecSync).toHaveBeenCalledWith("npx skills remove -g dosu -y", {
      stdio: "inherit",
    });
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
      expect.stringContaining("npx skills add dosu-ai/dosu-skill -g"),
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
  it("installs only for the selected MCP providers", async () => {
    const result = await installSkill(["claude", "codex"]);

    expect(result.success).toBe(true);
    expect(mockExecSync).toHaveBeenCalledWith(
      'npx skills add dosu-ai/dosu-skill -g -a claude-code -a codex -s "*" -y',
      { stdio: "inherit" },
    );
  });

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
      path: join(homedir(), ".agents", "skills", "dosu"),
      symlink: false,
    });
  });

  it("reports project-local targets for Claude, Codex, and Factory", () => {
    const root = "/tmp/project";

    expect(skillInstallTargetForProvider("claude", root)).toEqual({
      path: join(root, ".claude", "skills", "dosu"),
      symlink: false,
    });
    expect(skillInstallTargetForProvider("codex", root)).toEqual({
      path: join(root, ".agents", "skills", "dosu"),
      symlink: false,
    });
    expect(skillInstallTargetForProvider("factory", root)).toEqual({
      path: join(root, ".factory", "skills", "dosu"),
      symlink: false,
    });
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

  it("verifies each project skill target before legacy cleanup", () => {
    const projectRoot = join(tempDir, "project");
    mkdirSync(projectRoot);
    writeOwnedSkillLock(join(projectRoot, "skills-lock.json"));
    writeDosuSkill(join(projectRoot, ".claude", "skills", "dosu"));
    writeDosuSkill(join(projectRoot, ".agents", "skills", "dosu"));

    expect(verifiedProjectSkillProviderIDs(["claude", "cursor"], projectRoot)).toEqual([
      "claude",
      "cursor",
    ]);

    writeFileSync(
      join(projectRoot, ".claude", "skills", "dosu", "SKILL.md"),
      "---\nname: dosu\n---\n# Foreign skill\n",
    );
    expect(verifiedProjectSkillProviderIDs(["claude", "cursor"], projectRoot)).toEqual(["cursor"]);
  });

  it("does not verify a project skill without an owned lock or through a symlink", () => {
    const projectRoot = join(tempDir, "project");
    const outside = join(tempDir, "outside-skill");
    mkdirSync(projectRoot);
    writeDosuSkill(outside);
    mkdirSync(join(projectRoot, ".claude", "skills"), { recursive: true });
    symlinkSync(outside, join(projectRoot, ".claude", "skills", "dosu"));

    expect(verifiedProjectSkillProviderIDs(["claude"], projectRoot)).toEqual([]);

    writeOwnedSkillLock(join(projectRoot, "skills-lock.json"));
    expect(verifiedProjectSkillProviderIDs(["claude"], projectRoot)).toEqual([]);
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

  it("installs selected skills in the project without the global flag", async () => {
    await installSkill(["claude", "codex"], { quiet: true, projectRoot: "/tmp/project" });

    expect(mockExec).toHaveBeenCalledWith(
      'npx skills add dosu-ai/dosu-skill -a claude-code codex -s "*" --copy -y',
      { windowsHide: true, cwd: "/tmp/project" },
      expect.any(Function),
    );
  });

  it("refuses a symlinked project skills lock before running the installer", async () => {
    const projectRoot = join(tempDir, "project");
    mkdirSync(projectRoot);
    const outsideLock = join(tempDir, "outside-skills-lock.json");
    writeFileSync(outsideLock, "{}\n");
    symlinkSync(outsideLock, join(projectRoot, "skills-lock.json"));

    await expect(installSkill(["claude"], { quiet: true, projectRoot })).rejects.toThrow(
      "symbolic link",
    );
    expect(mockExec).not.toHaveBeenCalled();
    expect(readFileSync(outsideLock, "utf-8")).toBe("{}\n");
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
