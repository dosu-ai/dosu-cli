/**
 * GitHub token detection and repository validation.
 *
 * Token cascade: GH_TOKEN env var → GITHUB_TOKEN env var → `gh auth token` CLI fallback.
 */

import { execFileSync } from "node:child_process";

export interface RepoInfo {
  owner: string;
  repo: string;
  slug: string;
  description: string;
  html_url: string;
  default_branch: string;
  private: boolean;
}

/**
 * Parse an "owner/repo" slug into its parts.
 * Throws if the format is invalid.
 */
export function parseRepoSlug(slug: string): { owner: string; repo: string } {
  const parts = slug.split("/");
  if (parts.length !== 2 || !parts[0] || !parts[1]) {
    throw new Error(`invalid repository format: "${slug}". Expected "owner/repo"`);
  }
  return { owner: parts[0], repo: parts[1] };
}

/**
 * Resolve a GitHub token from the environment or the `gh` CLI.
 * Returns the token string, or null if none found.
 */
export function resolveGitHubToken(): string | null {
  // 1. GH_TOKEN (GitHub CLI's primary env var)
  if (process.env.GH_TOKEN) return process.env.GH_TOKEN;

  // 2. GITHUB_TOKEN (CI / Actions)
  if (process.env.GITHUB_TOKEN) return process.env.GITHUB_TOKEN;

  // 3. `gh auth token` CLI fallback
  try {
    const token = execFileSync("gh", ["auth", "token"], {
      encoding: "utf-8",
      timeout: 5_000,
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
    if (token) return token;
  } catch {
    // gh not installed or not authenticated — fall through
  }

  return null;
}

/**
 * Validate that a repo exists and is public via the GitHub API.
 * Returns repo info on success, throws on failure.
 */
export async function validatePublicRepo(
  owner: string,
  repo: string,
  token?: string,
): Promise<RepoInfo> {
  const url = `https://api.github.com/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}`;

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 10_000);

  try {
    const headers: Record<string, string> = {
      Accept: "application/vnd.github+json",
      "X-GitHub-Api-Version": "2022-11-28",
    };
    if (token) {
      headers.Authorization = `Bearer ${token}`;
    }

    const resp = await fetch(url, { headers, signal: controller.signal });

    if (resp.status === 404) {
      throw new Error(`repository "${owner}/${repo}" not found`);
    }
    if (resp.status === 401 || resp.status === 403) {
      throw new Error(
        "GitHub token is invalid or expired. Check your GH_TOKEN or run `gh auth login`",
      );
    }
    if (!resp.ok) {
      throw new Error(`GitHub API error (status ${resp.status})`);
    }

    const data = (await resp.json()) as {
      name: string;
      full_name: string;
      description: string | null;
      html_url: string;
      default_branch: string;
      private: boolean;
    };

    if (data.private) {
      throw new Error(
        `"${owner}/${repo}" is a private repository. Only public repositories can be added as Dosu public libraries`,
      );
    }

    return {
      owner,
      repo: data.name,
      slug: data.full_name,
      description: data.description ?? "",
      html_url: data.html_url,
      default_branch: data.default_branch,
      private: data.private,
    };
  } finally {
    clearTimeout(timeout);
  }
}
