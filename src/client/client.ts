/**
 * HTTP client for making authenticated requests to the Dosu backend.
 */

import {
  SessionExpiredError,
  SessionPersistenceError,
  SessionRefreshError,
} from "../auth/session-errors";
import type { Config } from "../config/config";
import {
  getConfigUserID,
  isAuthenticated,
  isTokenExpired,
  loadConfig,
  saveConfig,
} from "../config/config";
import { withConfigRefreshLock } from "../config/config-lock";
import { getBackendURL, getSupabaseAnonKey, getSupabaseURL } from "../config/constants";
import { getAccessTokenOAuthClientID } from "../config/identity";

export { SessionExpiredError };

const REFRESH_REQUEST_TIMEOUT_MS = 10_000;

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

    const requestAccessToken = this.config.active_account?.session.access_token;
    let resp = await this.doRequestOnce(method, path, body);

    // If backend says unauthorized, try refresh + retry once
    if (resp.status === 401 || resp.status === 403) {
      const currentAccessToken = this.config.active_account?.session.access_token;
      if (!currentAccessToken || currentAccessToken === requestAccessToken) {
        await this.refreshToken();
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
   * Public method to refresh token externally (used during auth step).
   *
   * The lock covers the complete read -> remote refresh -> atomic save cycle,
   * so sibling processes cannot rotate the same refresh token concurrently.
   * Refreshed credentials become visible in memory only after they are durable.
   */
  async refreshToken(): Promise<void> {
    const refreshTokenAtStart = this.config.active_account?.session.refresh_token;
    if (!refreshTokenAtStart) {
      throw new SessionExpiredError();
    }

    await withConfigRefreshLock(async () => {
      const disk = loadConfig();
      this.assertSameActiveAccount(disk);
      const diskRefreshToken = disk.active_account?.session.refresh_token;
      if (!diskRefreshToken) throw new SessionExpiredError();
      const diskHasNewerSession = diskRefreshToken !== refreshTokenAtStart;

      if (diskHasNewerSession && !isTokenExpired(disk)) {
        this.adoptConfig(disk);
        return;
      }

      const candidate = await this.refreshTokenOnce(disk);
      try {
        saveConfig(candidate);
      } catch (cause) {
        throw new SessionPersistenceError({ cause });
      }
      this.adoptConfig(candidate);
    });
  }

  private async refreshTokenOnce(source: Config): Promise<Config> {
    const session = source.active_account?.session;
    if (!session?.refresh_token) throw new SessionExpiredError();

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

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), REFRESH_REQUEST_TIMEOUT_MS);
    let resp: Response;
    try {
      resp = await fetch(endpoint, {
        method: "POST",
        headers,
        body,
        signal: controller.signal,
      });
    } catch (cause) {
      throw new SessionRefreshError({ cause });
    } finally {
      clearTimeout(timeout);
    }

    if (resp.status !== 200) {
      const errorCode = await readAuthErrorCode(resp);
      if (REAUTHENTICATION_ERROR_CODES.has(errorCode ?? "")) {
        throw new SessionExpiredError();
      }
      throw new SessionRefreshError({ status: resp.status });
    }

    const data = await readRefreshResponse(resp);

    // A browser login in another process may have switched accounts while the
    // refresh request was in flight. Never let this stale client overwrite the
    // new account aggregate with tokens from the previous account.
    const latest = loadConfig();
    this.assertSameActiveAccount(latest);
    const latestSession = latest.active_account?.session;
    if (!latestSession?.refresh_token) throw new SessionExpiredError();
    if (latestSession.refresh_token !== session.refresh_token) {
      return latest;
    }

    return configWithSession(latest, {
      access_token: data.access_token,
      refresh_token: data.refresh_token,
      expires_at: Math.floor(Date.now() / 1000) + data.expires_in,
    });
  }

  private adoptConfig(source: Config): void {
    this.config.mode = source.mode;
    this.config.active_account = source.active_account
      ? {
          ...source.active_account,
          session: { ...source.active_account.session },
          target: source.active_account.target ? { ...source.active_account.target } : undefined,
        }
      : undefined;
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

const REAUTHENTICATION_ERROR_CODES = new Set([
  "invalid_grant",
  "refresh_token_already_used",
  "refresh_token_not_found",
  "session_expired",
  "session_not_found",
]);

interface RefreshResponse {
  access_token: string;
  refresh_token: string;
  expires_in: number;
}

async function readAuthErrorCode(resp: Response): Promise<string | undefined> {
  try {
    const data = (await resp.json()) as unknown;
    if (!isRecord(data)) return undefined;
    const code = typeof data.error_code === "string" ? data.error_code : data.error;
    return typeof code === "string" ? code : undefined;
  } catch {
    return undefined;
  }
}

async function readRefreshResponse(resp: Response): Promise<RefreshResponse> {
  let data: unknown;
  try {
    data = await resp.json();
  } catch (cause) {
    throw new SessionRefreshError({ cause, status: resp.status });
  }
  if (
    !isRecord(data) ||
    typeof data.access_token !== "string" ||
    typeof data.refresh_token !== "string" ||
    typeof data.expires_in !== "number" ||
    !Number.isFinite(data.expires_in)
  ) {
    throw new SessionRefreshError({ status: resp.status });
  }
  return {
    access_token: data.access_token,
    refresh_token: data.refresh_token,
    expires_in: data.expires_in,
  };
}

function configWithSession(
  source: Config,
  session: NonNullable<Config["active_account"]>["session"],
): Config {
  const account = source.active_account;
  if (!account) throw new SessionExpiredError();
  return {
    ...source,
    active_account: {
      ...account,
      session,
      target: account.target ? { ...account.target } : undefined,
    },
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

async function readErrorBody(resp: Response): Promise<string> {
  try {
    const text = await resp.text();
    return text.slice(0, 1024);
  } catch {
    return "";
  }
}
