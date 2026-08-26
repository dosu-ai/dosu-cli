import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mockSpawnSync = vi.fn();
const mockSpawn = vi.fn();
vi.mock("node:child_process", () => ({
  spawn: (...args: unknown[]) => mockSpawn(...args),
  spawnSync: (...args: unknown[]) => mockSpawnSync(...args),
}));
vi.mock("../mcp/detect", () => ({
  findNpx: () => "/trusted/bin/npx",
  npxPathEnv: () => "/trusted/bin:/usr/bin:/bin",
}));

import {
  installedDosuSkillState,
  installSkill,
  installSkillForAgents,
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
  mockSpawn.mockReset();
  mockSpawn.mockImplementation(() => {
    const child = {
      once(event: string, callback: (...args: unknown[]) => void) {
        if (event === "close") callback(0);
        return child;
      },
    };
    return child;
  });
  mockSpawnSync.mockReset();
  mockSpawnSync.mockReturnValue({ status: 0, stdout: "" });
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
  it("runs npx skills add with correct args", async () => {
    await run("install");
    expect(mockSpawnSync).toHaveBeenCalledWith(
      "/trusted/bin/npx",
      [
        "skills",
        "add",
        "dosu-ai/dosu-skill",
        "-g",
        "-a",
        "claude-code",
        "-a",
        "cursor",
        "-a",
        "gemini-cli",
        "-a",
        "codex",
        "-a",
        "windsurf",
        "-a",
        "zed",
        "-a",
        "cline",
        "-a",
        "github-copilot",
        "-a",
        "opencode",
        "-a",
        "antigravity",
        "-a",
        "droid",
        "-s",
        "*",
        "-y",
      ],
      expect.objectContaining({ cwd: homedir(), shell: false, stdio: "inherit" }),
    );
  });

  it("does not let skills auto-target PromptScript", async () => {
    await run("install");
    const args = mockSpawnSync.mock.calls[0][1] as string[];
    expect(args).toContain("claude-code");
    expect(args).not.toContain("promptscript");
  });

  it("prints success message", async () => {
    await run("install");
    expect(allOutput()).toContain("installed successfully");
  });

  it("exits with error when the installer throws", async () => {
    mockSpawnSync.mockImplementation(() => {
      throw new Error("command failed");
    });
    await expect(run("install")).rejects.toThrow("exit");
    expect(allErrors()).toContain("Failed to install skill");
  });
});

describe("skill remove", () => {
  /** Make `npx skills list -g --json` resolve to the given inventory. */
  function stubInventory(entries: unknown[]): void {
    mockSpawnSync.mockImplementation((_command: string, args: string[]) => ({
      status: 0,
      stdout: args.includes("list") ? JSON.stringify(entries) : "",
    }));
  }

  it("removes every skill installed from the Dosu repo", async () => {
    stubInventory([
      { name: "dosu", source: "dosu-ai/dosu-skill" },
      { name: "dosu-review", source: "dosu-ai/dosu-skill" },
    ]);
    await run("remove");
    expect(mockSpawnSync).toHaveBeenCalledWith(
      "/trusted/bin/npx",
      ["skills", "remove", "-g", "dosu", "dosu-review", "-y"],
      expect.objectContaining({ cwd: homedir(), shell: false, stdio: "inherit" }),
    );
  });

  it("leaves skills from other sources alone", async () => {
    stubInventory([
      { name: "dosu", source: "dosu-ai/dosu-skill" },
      { name: "web-design", source: "vercel-labs/agent-skills" },
      { name: "local-skill", source: null },
    ]);
    await run("remove");
    expect(mockSpawnSync).toHaveBeenCalledWith(
      "/trusted/bin/npx",
      ["skills", "remove", "-g", "dosu", "-y"],
      expect.objectContaining({ shell: false }),
    );
  });

  it("skips names that are unsafe to interpolate into a shell command", async () => {
    stubInventory([
      { name: "dosu", source: "dosu-ai/dosu-skill" },
      { name: "evil; rm -rf /", source: "dosu-ai/dosu-skill" },
    ]);
    await run("remove");
    expect(mockSpawnSync).toHaveBeenCalledWith(
      "/trusted/bin/npx",
      ["skills", "remove", "-g", "dosu", "-y"],
      expect.anything(),
    );
  });

  // `skills list` echoes the front-matter name without validating it, and
  // `skills remove --all` deletes every skill from every source.
  it("skips flag-shaped names so they cannot be re-parsed as options", async () => {
    stubInventory([
      { name: "dosu", source: "dosu-ai/dosu-skill" },
      { name: "--all", source: "dosu-ai/dosu-skill" },
    ]);
    await run("remove");
    expect(mockSpawnSync).toHaveBeenCalledWith(
      "/trusted/bin/npx",
      ["skills", "remove", "-g", "dosu", "-y"],
      expect.anything(),
    );
  });

  it("does nothing when the inventory holds no skills of ours", async () => {
    stubInventory([{ name: "web-design", source: "vercel-labs/agent-skills" }]);
    await run("remove");
    expect(mockSpawnSync.mock.calls.some((call) => (call[1] as string[]).includes("remove"))).toBe(
      false,
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
    expect(mockSpawnSync).toHaveBeenCalledWith(
      "/trusted/bin/npx",
      ["skills", "remove", "-g", "dosu", "-y"],
      expect.anything(),
    );
  });

  it("falls back to the known skill when the inventory is unreadable", async () => {
    mockSpawnSync.mockImplementation((_command: string, args: string[]) => {
      if (args.includes("list")) throw new Error("npx unavailable");
      return { status: 0, stdout: "" };
    });
    await run("remove");
    expect(mockSpawnSync).toHaveBeenCalledWith(
      "/trusted/bin/npx",
      ["skills", "remove", "-g", "dosu", "-y"],
      expect.anything(),
    );
  });

  it("prints success message", async () => {
    await run("remove");
    expect(allOutput()).toContain("removed");
  });

  it("exits with error when the command throws", async () => {
    mockSpawnSync.mockImplementation(() => {
      throw new Error("command failed");
    });
    await expect(run("remove")).rejects.toThrow("exit");
    expect(allErrors()).toContain("Failed to remove skill");
  });
});

describe("skill update", () => {
  beforeEach(() => {
    mockSpawnSync.mockImplementation((_command: string, args: string[]) => ({
      status: 0,
      stdout: args.includes("list")
        ? JSON.stringify([
            {
              name: "dosu",
              source: "dosu-ai/dosu-skill",
              agents: ["Claude Code", "Factory"],
            },
          ])
        : "",
    }));
  });

  it("reinstalls via npx skills add (update can't follow repo-layout moves)", async () => {
    await run("update");
    expect(mockSpawnSync).toHaveBeenCalledWith(
      "/trusted/bin/npx",
      [
        "skills",
        "add",
        "dosu-ai/dosu-skill",
        "-g",
        "-a",
        "claude-code",
        "-a",
        "droid",
        "-s",
        "*",
        "-y",
      ],
      expect.objectContaining({ cwd: homedir(), shell: false }),
    );
    expect(mockSpawnSync.mock.calls.some((call) => (call[1] as string[]).includes("update"))).toBe(
      false,
    );
  });

  it("prints success message", async () => {
    await run("update");
    expect(allOutput()).toContain("updated");
  });

  it("exits with error when the update command throws", async () => {
    mockSpawnSync.mockImplementation((_command: string, args: string[]) => {
      if (args.includes("list")) {
        return {
          status: 0,
          stdout: JSON.stringify([
            { name: "dosu", source: "dosu-ai/dosu-skill", agents: ["Claude Code"] },
          ]),
        };
      }
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
    expect(mockSpawnSync).toHaveBeenCalledWith(
      "/trusted/bin/npx",
      [
        "skills",
        "add",
        "dosu-ai/dosu-skill",
        "-g",
        "-a",
        "claude-code",
        "-a",
        "codex",
        "-s",
        "*",
        "-y",
      ],
      expect.objectContaining({ cwd: homedir(), shell: false }),
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

    expect(mockSpawn).toHaveBeenCalledWith(
      "/trusted/bin/npx",
      expect.any(Array),
      expect.objectContaining({
        cwd: homedir(),
        shell: false,
        stdio: "ignore",
        windowsHide: true,
      }),
    );
    expect(mockSpawnSync).not.toHaveBeenCalled();
  });

  it("always keeps quiet setup installs global", async () => {
    await installSkill(["claude", "codex"], { quiet: true });

    expect(mockSpawn).toHaveBeenCalledWith(
      "/trusted/bin/npx",
      [
        "skills",
        "add",
        "dosu-ai/dosu-skill",
        "-g",
        "-a",
        "claude-code",
        "-a",
        "codex",
        "-s",
        "*",
        "-y",
      ],
      expect.objectContaining({ cwd: homedir(), shell: false }),
    );
  });

  it("returns failure when the async quiet installer fails", async () => {
    mockSpawn.mockImplementation(() => {
      const child = {
        once(event: string, callback: (...args: unknown[]) => void) {
          if (event === "error") callback(new Error("command failed"));
          return child;
        },
      };
      return child;
    });

    const result = await installSkill(["claude"], { quiet: true });

    expect(result.success).toBe(false);
  });

  it("does not broaden an unsupported provider into an all-agent install", async () => {
    const result = await installSkill(["manual"]);

    expect(result.success).toBe(true);
    expect(mockSpawnSync).not.toHaveBeenCalled();
  });

  it("installs an explicit agent set without broadening it", async () => {
    const result = await installSkillForAgents(["claude-code", "droid"]);

    expect(result.success).toBe(true);
    expect(mockSpawnSync).toHaveBeenCalledWith(
      "/trusted/bin/npx",
      [
        "skills",
        "add",
        "dosu-ai/dosu-skill",
        "-g",
        "-a",
        "claude-code",
        "-a",
        "droid",
        "-s",
        "*",
        "-y",
      ],
      expect.objectContaining({ shell: false }),
    );
  });

  it("recovers the existing agent targets from the official skill inventory", () => {
    mockSpawnSync.mockReturnValue({
      status: 0,
      stdout: JSON.stringify([
        {
          name: "dosu",
          source: "dosu-ai/dosu-skill",
          agents: ["Claude Code", "Codex", "Factory", "Unknown Agent"],
        },
        {
          name: "foreign",
          source: "other/repo",
          agents: ["Cursor"],
        },
      ]),
    });

    expect(installedDosuSkillState()).toEqual({
      names: ["dosu"],
      agentIDs: ["claude-code", "codex", "droid"],
    });
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

  it("returns failure when the process throws", async () => {
    mockSpawnSync.mockImplementation(() => {
      throw new Error("command failed");
    });
    const result = await installSkill();
    expect(result.success).toBe(false);
    expect(result.sha).toBeUndefined();
  });
});
