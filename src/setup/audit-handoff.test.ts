import { beforeEach, describe, expect, it, vi } from "vitest";

const mockSpawnSync = vi.hoisted(() => vi.fn());
vi.mock("node:child_process", () => ({
  spawnSync: mockSpawnSync,
  execSync: vi.fn(),
}));

vi.mock("@clack/prompts", () => ({
  confirm: vi.fn(),
  isCancel: vi.fn(),
  log: {
    message: vi.fn(),
    warn: vi.fn(),
  },
}));

vi.mock("../debug/logger", () => ({
  logger: {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  },
}));

const mockDetectGitRepo = vi.hoisted(() => vi.fn());
vi.mock("./github-step", () => ({
  detectGitRepo: mockDetectGitRepo,
}));

import * as p from "@clack/prompts";
import {
  buildAuditHandoffPrompt,
  claudeCliAvailable,
  dosuInvocation,
  launchAuditAgent,
  offerAuditHandoff,
  printManualAuditNudge,
} from "./audit-handoff";

const REPO = { owner: "acme", name: "widgets", slug: "acme/widgets" };

beforeEach(() => {
  vi.clearAllMocks();
  mockDetectGitRepo.mockReturnValue(REPO);
  vi.mocked(p.isCancel).mockReturnValue(false);
});

describe("claudeCliAvailable", () => {
  it("returns true when `which claude` exits 0", () => {
    mockSpawnSync.mockReturnValue({ status: 0 });
    expect(claudeCliAvailable()).toBe(true);
    expect(mockSpawnSync).toHaveBeenCalledWith(
      process.platform === "win32" ? "where" : "which",
      ["claude"],
      { stdio: "ignore" },
    );
  });

  it("returns false when the lookup exits non-zero", () => {
    mockSpawnSync.mockReturnValue({ status: 1 });
    expect(claudeCliAvailable()).toBe(false);
  });

  it("returns false when the lookup itself throws", () => {
    mockSpawnSync.mockImplementation(() => {
      throw new Error("boom");
    });
    expect(claudeCliAvailable()).toBe(false);
  });
});

describe("offerAuditHandoff", () => {
  it("stays silent outside a GitHub repo", async () => {
    mockDetectGitRepo.mockReturnValue(null);

    await expect(offerAuditHandoff()).resolves.toBe(false);
    expect(p.confirm).not.toHaveBeenCalled();
    expect(p.log.message).not.toHaveBeenCalled();
  });

  it("prints the manual nudge when Claude Code is not installed", async () => {
    mockSpawnSync.mockReturnValue({ status: 1 });

    await expect(offerAuditHandoff()).resolves.toBe(false);
    expect(p.confirm).not.toHaveBeenCalled();
    // No global `dosu` either (same PATH lookup), so the nudge uses npx.
    expect(p.log.message).toHaveBeenCalledWith(expect.stringContaining("npx -y @dosu/cli audit"));
  });

  it("returns true when the user confirms", async () => {
    mockSpawnSync.mockReturnValue({ status: 0 });
    vi.mocked(p.confirm).mockResolvedValue(true);

    await expect(offerAuditHandoff()).resolves.toBe(true);
    expect(p.log.message).not.toHaveBeenCalled();
  });

  it("prints the manual nudge when the user declines", async () => {
    mockSpawnSync.mockReturnValue({ status: 0 });
    vi.mocked(p.confirm).mockResolvedValue(false);

    await expect(offerAuditHandoff()).resolves.toBe(false);
    expect(p.log.message).toHaveBeenCalledWith(expect.stringContaining("dosu audit"));
  });

  it("prints the manual nudge when the prompt is cancelled", async () => {
    mockSpawnSync.mockReturnValue({ status: 0 });
    const cancel = Symbol("cancel");
    vi.mocked(p.confirm).mockResolvedValue(cancel as unknown as boolean);
    vi.mocked(p.isCancel).mockReturnValue(true);

    await expect(offerAuditHandoff()).resolves.toBe(false);
    expect(p.log.message).toHaveBeenCalledWith(expect.stringContaining("dosu audit"));
  });
});

describe("launchAuditAgent", () => {
  it("hands off to `claude` with the audit prompt on inherited stdio", () => {
    mockSpawnSync.mockReturnValue({ status: 0 });

    launchAuditAgent();

    expect(mockSpawnSync).toHaveBeenCalledWith("claude", [buildAuditHandoffPrompt("dosu")], {
      stdio: "inherit",
    });
    expect(p.log.message).not.toHaveBeenCalled();
  });

  it("falls back to the manual nudge when the launch errors", () => {
    mockSpawnSync.mockReturnValue({ status: null, error: new Error("ENOENT") });

    launchAuditAgent();

    expect(p.log.message).toHaveBeenCalledWith(expect.stringContaining("audit"));
  });
});

describe("buildAuditHandoffPrompt", () => {
  it("tells the agent how to write findings and finish with dosu audit", () => {
    const prompt = buildAuditHandoffPrompt("dosu");
    expect(prompt).toContain(".dosu/audit.json");
    expect(prompt).toContain("dosu audit --tasks");
  });

  it("uses npx when dosu is not globally installed", () => {
    const prompt = buildAuditHandoffPrompt("npx -y @dosu/cli");
    expect(prompt).toContain("npx -y @dosu/cli audit --tasks");
  });
});

describe("dosuInvocation", () => {
  it("returns bare dosu when it's on PATH", () => {
    mockSpawnSync.mockReturnValue({ status: 0 });
    expect(dosuInvocation()).toBe("dosu");
  });

  it("returns the npx form when dosu is not on PATH", () => {
    mockSpawnSync.mockReturnValue({ status: 1 });
    expect(dosuInvocation()).toBe("npx -y @dosu/cli");
  });
});

describe("printManualAuditNudge", () => {
  it("mentions both the agent ask and the dosu audit fallback", () => {
    mockSpawnSync.mockReturnValue({ status: 0 });
    printManualAuditNudge();

    expect(p.log.message).toHaveBeenCalledWith(expect.stringContaining("audit this repo"));
    expect(p.log.message).toHaveBeenCalledWith(expect.stringContaining("dosu audit"));
  });
});
