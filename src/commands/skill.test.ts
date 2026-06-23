import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mockExecSync = vi.fn();
vi.mock("node:child_process", () => ({
  execSync: (...args: unknown[]) => mockExecSync(...args),
}));

import { installSkill, skillCommand } from "./skill";

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
    expect(mockExecSync).toHaveBeenCalledWith("npx skills remove -g -s dosu -y", {
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
  it("runs npx skills update with correct args", async () => {
    await run("update");
    expect(mockExecSync).toHaveBeenCalledWith("npx skills update dosu -g", {
      stdio: "inherit",
    });
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
