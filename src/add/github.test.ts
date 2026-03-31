import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Mock child_process at the boundary
vi.mock("node:child_process", () => ({
  execFileSync: vi.fn(),
}));

import { execFileSync } from "node:child_process";
import { parseRepoSlug, resolveGitHubToken, validatePublicRepo } from "./github";

// ── parseRepoSlug ──────────────────────────────────────────────────────────

describe("parseRepoSlug", () => {
  it("parses valid owner/repo slug", () => {
    expect(parseRepoSlug("dosu-ai/dosu")).toEqual({ owner: "dosu-ai", repo: "dosu" });
  });

  it("rejects slug with no slash", () => {
    expect(() => parseRepoSlug("dosu")).toThrow('invalid repository format: "dosu"');
  });

  it("rejects slug with too many slashes", () => {
    expect(() => parseRepoSlug("a/b/c")).toThrow('invalid repository format: "a/b/c"');
  });

  it("rejects empty owner", () => {
    expect(() => parseRepoSlug("/repo")).toThrow('invalid repository format: "/repo"');
  });

  it("rejects empty repo", () => {
    expect(() => parseRepoSlug("owner/")).toThrow('invalid repository format: "owner/"');
  });

  it("rejects empty string", () => {
    expect(() => parseRepoSlug("")).toThrow('invalid repository format: ""');
  });
});

// ── resolveGitHubToken ─────────────────────────────────────────────────────

describe("resolveGitHubToken", () => {
  let origGH: string | undefined;
  let origGITHUB: string | undefined;

  beforeEach(() => {
    origGH = process.env.GH_TOKEN;
    origGITHUB = process.env.GITHUB_TOKEN;
    delete process.env.GH_TOKEN;
    delete process.env.GITHUB_TOKEN;
    vi.clearAllMocks();
  });

  afterEach(() => {
    if (origGH !== undefined) process.env.GH_TOKEN = origGH;
    else delete process.env.GH_TOKEN;
    if (origGITHUB !== undefined) process.env.GITHUB_TOKEN = origGITHUB;
    else delete process.env.GITHUB_TOKEN;
  });

  it("returns GH_TOKEN when set", () => {
    process.env.GH_TOKEN = "gh_tok_123";
    expect(resolveGitHubToken()).toBe("gh_tok_123");
  });

  it("returns GITHUB_TOKEN when GH_TOKEN is not set", () => {
    process.env.GITHUB_TOKEN = "github_tok_456";
    expect(resolveGitHubToken()).toBe("github_tok_456");
  });

  it("prefers GH_TOKEN over GITHUB_TOKEN", () => {
    process.env.GH_TOKEN = "gh_tok_123";
    process.env.GITHUB_TOKEN = "github_tok_456";
    expect(resolveGitHubToken()).toBe("gh_tok_123");
  });

  it("falls back to gh auth token CLI", () => {
    vi.mocked(execFileSync).mockReturnValue("cli_token_789\n");
    expect(resolveGitHubToken()).toBe("cli_token_789");
    expect(execFileSync).toHaveBeenCalledWith("gh", ["auth", "token"], expect.any(Object));
  });

  it("returns null when no token source available", () => {
    vi.mocked(execFileSync).mockImplementation(() => {
      throw new Error("gh not found");
    });
    expect(resolveGitHubToken()).toBeNull();
  });

  it("returns null when gh returns empty string", () => {
    vi.mocked(execFileSync).mockReturnValue("  \n");
    expect(resolveGitHubToken()).toBeNull();
  });
});

// ── validatePublicRepo ─────────────────────────────────────────────────────

const mockFetch = vi.fn();
vi.stubGlobal("fetch", mockFetch);

describe("validatePublicRepo", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("returns repo info for a public repo", async () => {
    mockFetch.mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({
        name: "dosu",
        full_name: "dosu-ai/dosu",
        description: "A cool project",
        html_url: "https://github.com/dosu-ai/dosu",
        default_branch: "main",
        private: false,
      }),
    });

    const info = await validatePublicRepo("dosu-ai", "dosu", "tok_123");
    expect(info.slug).toBe("dosu-ai/dosu");
    expect(info.private).toBe(false);
    expect(info.description).toBe("A cool project");
  });

  it("throws for a private repo", async () => {
    mockFetch.mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({
        name: "secret",
        full_name: "dosu-ai/secret",
        description: null,
        html_url: "https://github.com/dosu-ai/secret",
        default_branch: "main",
        private: true,
      }),
    });

    await expect(validatePublicRepo("dosu-ai", "secret", "tok_123")).rejects.toThrow(
      "private repository",
    );
  });

  it("throws for a 404", async () => {
    mockFetch.mockResolvedValue({ ok: false, status: 404 });
    await expect(validatePublicRepo("dosu-ai", "nope", "tok_123")).rejects.toThrow("not found");
  });

  it("throws for a 401", async () => {
    mockFetch.mockResolvedValue({ ok: false, status: 401 });
    await expect(validatePublicRepo("dosu-ai", "dosu", "bad_tok")).rejects.toThrow(
      "invalid or expired",
    );
  });

  it("throws for a 403", async () => {
    mockFetch.mockResolvedValue({ ok: false, status: 403 });
    await expect(validatePublicRepo("dosu-ai", "dosu", "bad_tok")).rejects.toThrow(
      "invalid or expired",
    );
  });

  it("throws for other errors", async () => {
    mockFetch.mockResolvedValue({ ok: false, status: 500 });
    await expect(validatePublicRepo("dosu-ai", "dosu", "tok")).rejects.toThrow(
      "GitHub API error (status 500)",
    );
  });

  it("omits Authorization header when no token provided", async () => {
    mockFetch.mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({
        name: "dosu",
        full_name: "dosu-ai/dosu",
        description: null,
        html_url: "https://github.com/dosu-ai/dosu",
        default_branch: "main",
        private: false,
      }),
    });

    await validatePublicRepo("dosu-ai", "dosu");
    const headers = mockFetch.mock.calls[0][1].headers;
    expect(headers.Authorization).toBeUndefined();
    expect(headers.Accept).toBe("application/vnd.github+json");
  });

  it("handles null description", async () => {
    mockFetch.mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({
        name: "dosu",
        full_name: "dosu-ai/dosu",
        description: null,
        html_url: "https://github.com/dosu-ai/dosu",
        default_branch: "main",
        private: false,
      }),
    });

    const info = await validatePublicRepo("dosu-ai", "dosu", "tok");
    expect(info.description).toBe("");
  });
});
