/**
 * HTTP client for making authenticated requests to the Dosu backend.
 */

import type { Config } from "../config/config";
import {
  getConfigUserID,
  isAuthenticated,
  isTokenExpired,
  loadConfig,
  saveConfig,
} from "../config/config";
import { getBackendURL, getSupabaseAnonKey, getSupabaseURL } from "../config/constants";
import { getAccessTokenOAuthClientID } from "../config/identity";

export class SessionExpiredError extends Error {
  constructor() {
    super("session expired");
    this.name = "SessionExpiredError";
  }
}

export interface Deployment {
  deployment_id: string;
  name: string;
  description: string;
  provider_slug: string;
  enabled: boolean;
  org_id: string;
  org_name: string;
  space_id: string;
}

export interface Org {
  org_id: string;
  name: string;
}

export interface APIKeyResponse {
  api_key: string;
  id: string;
  name: string;
  key_prefix: string;
}

export class Client {
  private baseURL: string;
  private config: Config;

  constructor(cfg: Config) {
    this.baseURL = getBackendURL();
    this.config = cfg;
  }

  /**
   * Performs an authenticated HTTP request with auto-refresh on 401/403.
   */
  async doRequest(method: string, path: string, body?: unknown): Promise<Response> {
    if (!isAuthenticated(this.config)) {
      throw new Error("not authenticated - please run setup first");
    }

    // Pre-emptive refresh if locally known to be expired
    if (isTokenExpired(this.config)) {
      await this.refreshToken();
    }

    let resp = await this.doRequestOnce(method, path, body);

    // If backend says unauthorized, try refresh + retry once
    if (resp.status === 401 || resp.status === 403) {
      try {
        await this.refreshToken();
      } catch {
        throw new SessionExpiredError();
      }
      resp = await this.doRequestOnce(method, path, body);
    }

    return resp;
  }

  /**
   * Performs a single authenticated request without any retry/refresh logic.
   */
  async doRequestRaw(method: string, path: string): Promise<Response> {
    return this.doRequestOnce(method, path);
  }

  private async doRequestOnce(method: string, path: string, body?: unknown): Promise<Response> {
    const url = this.baseURL + path;
    const headers: Record<string, string> = {
      "Content-Type": "application/json",
      "Supabase-Access-Token": this.config.active_account?.session.access_token ?? "",
    };

    const options: RequestInit = { method, headers };
    if (body !== undefined) {
      options.body = JSON.stringify(body);
    }

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 10_000);
    options.signal = controller.signal;

    try {
      return await fetch(url, options);
    } finally {
      clearTimeout(timeout);
    }
  }

  async get(path: string): Promise<Response> {
    return this.doRequest("GET", path);
  }

  async post(path: string, body: unknown): Promise<Response> {
    return this.doRequest("POST", path, body);
  }

  async put(path: string, body: unknown): Promise<Response> {
    return this.doRequest("PUT", path, body);
  }

  async delete(path: string): Promise<Response> {
    return this.doRequest("DELETE", path);
  }

  /**
   * API-key-authenticated requests (`X-Dosu-API-Key`) — the same credential the
   * MCP integration uses. Unlike {@link doRequest}, these carry no Supabase OAuth
   * token and never refresh: the API key is long-lived, so callers that run as
   * frequent short-lived processes (e.g. the knowledge hooks) are not subject to
   * hourly token expiry or refresh-token rotation races.
   */
  async getWithApiKey(path: string): Promise<Response> {
    return this.apiKeyRequest("GET", path);
  }

  async postWithApiKey(path: string, body: unknown): Promise<Response> {
    return this.apiKeyRequest("POST", path, body);
  }

  private async apiKeyRequest(method: string, path: string, body?: unknown): Promise<Response> {
    if (!this.config.active_account?.target?.api_key) {
      throw new Error("no API key available");
    }
    const url = this.baseURL + path;
    const headers: Record<string, string> = {
      "Content-Type": "application/json",
      "X-Dosu-API-Key": this.config.active_account?.target?.api_key,
    };

    const options: RequestInit = { method, headers };
    if (body !== undefined) {
      options.body = JSON.stringify(body);
    }

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 10_000);
    options.signal = controller.signal;

    try {
      return await fetch(url, options);
    } finally {
      clearTimeout(timeout);
    }
  }

  /**
   * Public method to refresh token externally (used during auth step).
   *
   * Multi-process self-healing: sibling CLI processes rotate the refresh
   * token through the shared config file, and GoTrue refresh tokens are
   * single-use — replaying a stale one outside the reuse interval can revoke
   * the ENTIRE session for every client holding it. So: adopt the newest
   * on-disk tokens before refreshing (a long-lived process may hold a stale
   * in-memory copy), and on failure re-read the config once in case a
   * sibling rotated mid-flight.
   */
  async refreshToken(): Promise<void> {
    this.adoptNewerDiskTokens();
    if (!this.config.active_account?.session.refresh_token) {
      throw new Error("no refresh token available");
    }

    try {
      await this.refreshTokenOnce();
    } catch (err) {
      // A sibling may have rotated the token between our config read and the
      // request landing. If the file now holds a different token, retry once
      // with it before declaring the session dead.
      if (!this.adoptNewerDiskTokens()) {
        throw err;
      }
      await this.refreshTokenOnce();
    }
  }

  /**
   * Sync in-memory tokens from the config file when a sibling process saved
   * a different refresh token. Returns true when tokens were adopted.
   */
  private adoptNewerDiskTokens(): boolean {
    const disk = loadConfig();
    this.assertSameActiveAccount(disk);
    const diskSession = disk.active_account?.session;
    const memorySession = this.config.active_account?.session;
    if (
      !diskSession?.refresh_token ||
      !memorySession ||
      diskSession.refresh_token === memorySession.refresh_token
    ) {
      return false;
    }
    memorySession.access_token = diskSession.access_token;
    memorySession.refresh_token = diskSession.refresh_token;
    memorySession.expires_at = diskSession.expires_at;
    return true;
  }

  private async refreshTokenOnce(): Promise<void> {
    const session = this.config.active_account?.session;
    if (!session?.refresh_token) throw new Error("no refresh token available");

    const supabaseURL = getSupabaseURL();
    const oauthClientID = getAccessTokenOAuthClientID(session.access_token);
    const endpoint = oauthClientID
      ? `${supabaseURL}/auth/v1/oauth/token`
      : `${supabaseURL}/auth/v1/token?grant_type=refresh_token`;
    const headers: Record<string, string> = oauthClientID
      ? { "Content-Type": "application/x-www-form-urlencoded" }
      : { "Content-Type": "application/json", apikey: getSupabaseAnonKey() };
    const body = oauthClientID
      ? new URLSearchParams({
          grant_type: "refresh_token",
          refresh_token: session.refresh_token,
          client_id: oauthClientID,
        }).toString()
      : JSON.stringify({ refresh_token: session.refresh_token });

    const resp = await fetch(endpoint, {
      method: "POST",
      headers,
      body,
    });

    if (resp.status !== 200) {
      throw new Error(`refresh failed with status ${resp.status}`);
    }

    const data = (await resp.json()) as {
      access_token: string;
      refresh_token: string;
      expires_in: number;
    };

    // A browser login in another process may have switched accounts while the
    // refresh request was in flight. Never let this stale client overwrite the
    // new account aggregate with tokens from the previous account.
    this.assertSameActiveAccount(loadConfig());

    session.access_token = data.access_token;
    session.refresh_token = data.refresh_token;
    session.expires_at = Math.floor(Date.now() / 1000) + data.expires_in;

    saveConfig(this.config);
  }

  private assertSameActiveAccount(disk: Config): void {
    const memoryUserID = getConfigUserID(this.config);
    const diskUserID = getConfigUserID(disk);
    if (memoryUserID && diskUserID && memoryUserID !== diskUserID) {
      throw new Error("authenticated account changed while this command was running; retry it");
    }
  }

  async getDeployments(): Promise<Deployment[]> {
    const resp = await this.get("/v1/mcp/deployments");
    if (resp.status !== 200) {
      let detail = await readErrorBody(resp);
      if (!detail || detail === "Internal Server Error") {
        detail = "check backend logs for details";
      }
      throw new Error(`failed to fetch deployments (status ${resp.status}): ${detail}`);
    }
    return resp.json() as Promise<Deployment[]>;
  }

  async getOrgs(): Promise<Org[]> {
    const resp = await this.get("/v1/mcp/orgs");
    if (resp.status !== 200) {
      const detail = await readErrorBody(resp);
      throw new Error(`failed to fetch orgs (status ${resp.status}): ${detail}`);
    }
    return resp.json() as Promise<Org[]>;
  }

  /**
   * Validates an API key against the current backend.
   * Returns true if valid, false if invalid. On network errors, assumes valid (optimistic).
   */
  async validateAPIKey(apiKey: string, deploymentID: string): Promise<boolean> {
    try {
      const endpoint = `${this.baseURL}/v1/mcp/deployments/${encodeURIComponent(deploymentID)}`;
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 5_000);

      try {
        const resp = await fetch(endpoint, {
          method: "GET",
          headers: { "X-Dosu-API-Key": apiKey },
          signal: controller.signal,
        });
        return resp.status !== 401 && resp.status !== 403;
      } finally {
        clearTimeout(timeout);
      }
    } catch {
      return true; // network error — assume valid
    }
  }

  async createAPIKey(deploymentID: string, name: string): Promise<APIKeyResponse> {
    const path = `/v1/mcp/deployments/${deploymentID}/api-keys`;
    const resp = await this.post(path, { name });
    if (resp.status !== 200 && resp.status !== 201) {
      const detail = await readErrorBody(resp);
      throw new Error(`failed to create API key (status ${resp.status}): ${detail}`);
    }
    return resp.json() as Promise<APIKeyResponse>;
  }
}

async function readErrorBody(resp: Response): Promise<string> {
  try {
    const text = await resp.text();
    return text.slice(0, 1024);
  } catch {
    return "";
  }
}
