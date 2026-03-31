import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Mock boundaries: terminal UI, GitHub module, fetch
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

vi.mock("./github", () => ({
  parseRepoSlug: vi.fn(),
  resolveGitHubToken: vi.fn(),
  validatePublicRepo: vi.fn(),
}));

const mockFetch = vi.fn();
vi.stubGlobal("fetch", mockFetch);

import * as p from "@clack/prompts";
import type { Config } from "../config/config";
import { saveConfig } from "../config/config";
import { createPublicLibrary, runAdd } from "./flow";
import { parseRepoSlug, resolveGitHubToken, validatePublicRepo } from "./github";

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
  tempDir = mkdtempSync(join(tmpdir(), "dosu-add-test-"));
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

// ── runAdd ─────────────────────────────────────────────────────────────────

describe("runAdd", () => {
  it("fails on invalid slug", async () => {
    vi.mocked(parseRepoSlug).mockImplementation(() => {
      throw new Error('invalid repository format: "bad"');
    });

    await runAdd({ repo: "bad" });
    expect(p.log.error).toHaveBeenCalledWith(expect.stringContaining("invalid repository format"));
  });

  it("fails when not authenticated", async () => {
    vi.mocked(parseRepoSlug).mockReturnValue({ owner: "o", repo: "r" });
    saveConfig(makeCfg({ access_token: "" }));

    await runAdd({ repo: "o/r" });
    expect(p.log.error).toHaveBeenCalledWith(expect.stringContaining("Not logged in"));
  });

  it("fails when token expired", async () => {
    vi.mocked(parseRepoSlug).mockReturnValue({ owner: "o", repo: "r" });
    saveConfig(makeCfg({ expires_at: 1 }));

    await runAdd({ repo: "o/r" });
    expect(p.log.error).toHaveBeenCalledWith(expect.stringContaining("Session expired"));
  });

  it("fails when no API key", async () => {
    vi.mocked(parseRepoSlug).mockReturnValue({ owner: "o", repo: "r" });
    saveConfig(makeCfg({ api_key: undefined }));

    await runAdd({ repo: "o/r" });
    expect(p.log.error).toHaveBeenCalledWith(expect.stringContaining("No API key"));
  });

  it("fails when no GitHub token found", async () => {
    vi.mocked(parseRepoSlug).mockReturnValue({ owner: "o", repo: "r" });
    vi.mocked(resolveGitHubToken).mockReturnValue(null);
    saveConfig(makeCfg());

    await runAdd({ repo: "o/r" });
    expect(p.log.error).toHaveBeenCalledWith(expect.stringContaining("GitHub token"));
  });

  it("fails when repo validation fails", async () => {
    vi.mocked(parseRepoSlug).mockReturnValue({ owner: "o", repo: "r" });
    vi.mocked(resolveGitHubToken).mockReturnValue("gh_tok");
    vi.mocked(validatePublicRepo).mockRejectedValue(new Error("not found"));
    saveConfig(makeCfg());

    await runAdd({ repo: "o/r" });
    expect(p.log.error).toHaveBeenCalledWith("not found");
  });

  it("succeeds for a valid public repo (created)", async () => {
    vi.mocked(parseRepoSlug).mockReturnValue({ owner: "dosu-ai", repo: "dosu" });
    vi.mocked(resolveGitHubToken).mockReturnValue("gh_tok");
    vi.mocked(validatePublicRepo).mockResolvedValue({
      owner: "dosu-ai",
      repo: "dosu",
      slug: "dosu-ai/dosu",
      description: "A cool project",
      html_url: "https://github.com/dosu-ai/dosu",
      default_branch: "main",
      private: false,
    });
    mockFetch.mockResolvedValue({
      ok: true,
      status: 201,
      json: async () => ({
        status: "created",
        repo_slug: "dosu-ai/dosu",
        data_source_id: "ds-1",
        deployment_id: "dep-123",
        sync_triggered: true,
      }),
    });

    saveConfig(makeCfg());
    await runAdd({ repo: "dosu-ai/dosu" });

    expect(p.log.success).toHaveBeenCalledWith(expect.stringContaining("dosu-ai/dosu"));
    expect(p.log.message).toHaveBeenCalledWith(expect.stringContaining("ask_public_library"));
  });

  it("shows already-exists message on re-add", async () => {
    vi.mocked(parseRepoSlug).mockReturnValue({ owner: "o", repo: "r" });
    vi.mocked(resolveGitHubToken).mockReturnValue("gh_tok");
    vi.mocked(validatePublicRepo).mockResolvedValue({
      owner: "o",
      repo: "r",
      slug: "o/r",
      description: "",
      html_url: "https://github.com/o/r",
      default_branch: "main",
      private: false,
    });
    mockFetch.mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({
        status: "already_exists",
        repo_slug: "o/r",
        data_source_id: "ds-1",
        deployment_id: "dep-123",
        sync_triggered: true,
      }),
    });

    saveConfig(makeCfg());
    await runAdd({ repo: "o/r" });

    expect(p.log.success).toHaveBeenCalledWith(expect.stringContaining("o/r"));
  });

  it("handles backend failure", async () => {
    vi.mocked(parseRepoSlug).mockReturnValue({ owner: "o", repo: "r" });
    vi.mocked(resolveGitHubToken).mockReturnValue("gh_tok");
    vi.mocked(validatePublicRepo).mockResolvedValue({
      owner: "o",
      repo: "r",
      slug: "o/r",
      description: "",
      html_url: "https://github.com/o/r",
      default_branch: "main",
      private: false,
    });
    mockFetch.mockResolvedValue({
      ok: false,
      status: 500,
      text: async () => "internal error",
    });

    saveConfig(makeCfg());
    await runAdd({ repo: "o/r" });

    expect(p.log.error).toHaveBeenCalledWith(expect.stringContaining("status 500"));
  });

  it("handles API key auth error", async () => {
    vi.mocked(parseRepoSlug).mockReturnValue({ owner: "o", repo: "r" });
    vi.mocked(resolveGitHubToken).mockReturnValue("gh_tok");
    vi.mocked(validatePublicRepo).mockResolvedValue({
      owner: "o",
      repo: "r",
      slug: "o/r",
      description: "",
      html_url: "https://github.com/o/r",
      default_branch: "main",
      private: false,
    });
    mockFetch.mockResolvedValue({ ok: false, status: 401 });

    saveConfig(makeCfg());
    await runAdd({ repo: "o/r" });

    expect(p.log.error).toHaveBeenCalledWith(expect.stringContaining("API key is invalid"));
  });
});

// ── createPublicLibrary ────────────────────────────────────────────────────

describe("createPublicLibrary", () => {
  it("returns result on 201", async () => {
    const body = {
      status: "created",
      repo_slug: "o/r",
      data_source_id: "ds-1",
      deployment_id: "dep-1",
      sync_triggered: true,
    };
    mockFetch.mockResolvedValue({ ok: true, status: 201, json: async () => body });

    const result = await createPublicLibrary("key", "o/r", "tok");
    expect(result.status).toBe("created");
    expect(result.repo_slug).toBe("o/r");
  });

  it("returns result on 200 (already exists)", async () => {
    const body = {
      status: "already_exists",
      repo_slug: "o/r",
      data_source_id: "ds-1",
      deployment_id: "dep-1",
      sync_triggered: true,
    };
    mockFetch.mockResolvedValue({ ok: true, status: 200, json: async () => body });

    const result = await createPublicLibrary("key", "o/r", "tok");
    expect(result.status).toBe("already_exists");
  });

  it("throws on 401", async () => {
    mockFetch.mockResolvedValue({ ok: false, status: 401 });
    await expect(createPublicLibrary("bad", "o/r", "tok")).rejects.toThrow("API key is invalid");
  });

  it("throws on 403", async () => {
    mockFetch.mockResolvedValue({ ok: false, status: 403 });
    await expect(createPublicLibrary("bad", "o/r", "tok")).rejects.toThrow("API key is invalid");
  });

  it("throws on other errors", async () => {
    mockFetch.mockResolvedValue({
      ok: false,
      status: 500,
      text: async () => "server error",
    });
    await expect(createPublicLibrary("key", "o/r", "tok")).rejects.toThrow("status 500");
  });

  it("sends correct headers and body", async () => {
    mockFetch.mockResolvedValue({
      ok: true,
      status: 201,
      json: async () => ({
        status: "created",
        repo_slug: "o/r",
        data_source_id: "ds-1",
        deployment_id: "dep-1",
        sync_triggered: true,
      }),
    });

    await createPublicLibrary("my-key", "o/r", "gh-tok");

    expect(mockFetch).toHaveBeenCalledWith(
      expect.stringContaining("/v1/public-libraries"),
      expect.objectContaining({
        method: "POST",
        headers: expect.objectContaining({
          "X-Dosu-API-Key": "my-key",
        }),
        body: JSON.stringify({ repo_slug: "o/r", github_token: "gh-tok" }),
      }),
    );
  });
});
