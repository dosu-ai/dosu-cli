import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Mock boundaries
vi.mock("@clack/prompts", () => ({
  intro: vi.fn(),
  outro: vi.fn(),
  isCancel: vi.fn(),
  spinner: vi.fn(() => ({
    start: vi.fn(),
    stop: vi.fn(),
  })),
  log: {
    warn: vi.fn(),
    success: vi.fn(),
    error: vi.fn(),
    info: vi.fn(),
    message: vi.fn(),
  },
}));

vi.mock("../add/github", () => ({
  parseRepoSlug: vi.fn(),
  resolveGitHubToken: vi.fn(),
}));

vi.mock("../add/flow", () => ({
  createPublicLibrary: vi.fn(),
}));

import * as p from "@clack/prompts";
import { createPublicLibrary } from "../add/flow";
import { parseRepoSlug, resolveGitHubToken } from "../add/github";
import type { Config } from "../config/config";
import { saveConfig } from "../config/config";
import { runSync } from "./flow";

// ── Temp env ───────────────────────────────────────────────────────────────

let tempDir: string;
let origXDG: string | undefined;
let origHome: string | undefined;

function makeCfg(overrides: Partial<Config> = {}): Config {
  return {
    access_token: "tok",
    refresh_token: "ref",
    expires_at: Math.floor(Date.now() / 1000) + 3600,
    deployment_id: "dep-123",
    deployment_name: "TestDeploy",
    api_key: "key-abc",
    ...overrides,
  };
}

beforeEach(() => {
  tempDir = mkdtempSync(join(tmpdir(), "dosu-sync-test-"));
  origXDG = process.env.XDG_CONFIG_HOME;
  origHome = process.env.HOME;
  process.env.XDG_CONFIG_HOME = tempDir;
  process.env.HOME = tempDir;
  vi.clearAllMocks();
});

afterEach(() => {
  if (origXDG !== undefined) process.env.XDG_CONFIG_HOME = origXDG;
  else delete process.env.XDG_CONFIG_HOME;
  if (origHome !== undefined) process.env.HOME = origHome;
  else delete process.env.HOME;
  rmSync(tempDir, { recursive: true, force: true });
});

// ── runSync ────────────────────────────────────────────────────────────────

describe("runSync", () => {
  it("fails when no repo specified", async () => {
    await runSync({});
    expect(p.log.error).toHaveBeenCalledWith(
      expect.stringContaining("Please specify a repository"),
    );
  });

  it("fails when not authenticated", async () => {
    vi.mocked(parseRepoSlug).mockReturnValue({ owner: "o", repo: "r" });
    saveConfig(makeCfg({ access_token: "" }));
    await runSync({ repo: "o/r" });
    expect(p.log.error).toHaveBeenCalledWith(expect.stringContaining("Not logged in"));
  });

  it("fails when token expired", async () => {
    vi.mocked(parseRepoSlug).mockReturnValue({ owner: "o", repo: "r" });
    saveConfig(makeCfg({ expires_at: 1 }));
    await runSync({ repo: "o/r" });
    expect(p.log.error).toHaveBeenCalledWith(expect.stringContaining("Session expired"));
  });

  it("fails when no API key", async () => {
    vi.mocked(parseRepoSlug).mockReturnValue({ owner: "o", repo: "r" });
    saveConfig(makeCfg({ api_key: undefined }));
    await runSync({ repo: "o/r" });
    expect(p.log.error).toHaveBeenCalledWith(expect.stringContaining("No API key"));
  });

  it("fails on invalid slug format", async () => {
    vi.mocked(parseRepoSlug).mockImplementation(() => {
      throw new Error("invalid");
    });
    saveConfig(makeCfg());
    await runSync({ repo: "bad" });
    expect(p.log.error).toHaveBeenCalledWith("invalid");
  });

  it("fails when no GitHub token found", async () => {
    vi.mocked(parseRepoSlug).mockReturnValue({ owner: "o", repo: "r" });
    vi.mocked(resolveGitHubToken).mockReturnValue(null);
    saveConfig(makeCfg());
    await runSync({ repo: "o/r" });
    expect(p.log.error).toHaveBeenCalledWith(expect.stringContaining("GitHub token"));
  });

  it("syncs a repo successfully", async () => {
    vi.mocked(parseRepoSlug).mockReturnValue({ owner: "o", repo: "r" });
    vi.mocked(resolveGitHubToken).mockReturnValue("gh_tok");
    vi.mocked(createPublicLibrary).mockResolvedValue({
      status: "already_exists",
      repo_slug: "o/r",
      data_source_id: "ds-1",
      deployment_id: "dep-123",
      sync_triggered: true,
    });

    saveConfig(makeCfg());
    await runSync({ repo: "o/r" });

    expect(p.log.success).toHaveBeenCalledWith(expect.stringContaining("o/r"));
    expect(createPublicLibrary).toHaveBeenCalledWith("key-abc", "o/r", "gh_tok");
  });

  it("handles backend failure", async () => {
    vi.mocked(parseRepoSlug).mockReturnValue({ owner: "o", repo: "r" });
    vi.mocked(resolveGitHubToken).mockReturnValue("gh_tok");
    vi.mocked(createPublicLibrary).mockRejectedValue(
      new Error("failed to create public library (status 500): error"),
    );

    saveConfig(makeCfg());
    await runSync({ repo: "o/r" });

    expect(p.log.error).toHaveBeenCalledWith(expect.stringContaining("status 500"));
  });
});
