/**
 * HTTP client for making authenticated requests to the Dosu backend.
 */

import type { Config } from "../config/config";
import { isAuthenticated, isTokenExpired, saveConfig } from "../config/config";
import { getBackendURL, getSupabaseAnonKey, getSupabaseURL } from "../config/constants";

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
      "Supabase-Access-Token": this.config.access_token,
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
   */
  async refreshToken(): Promise<void> {
    if (!this.config.refresh_token) {
      throw new Error("no refresh token available");
    }

    const supabaseURL = getSupabaseURL();
    const endpoint = `${supabaseURL}/auth/v1/token?grant_type=refresh_token`;

    const resp = await fetch(endpoint, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        apikey: getSupabaseAnonKey(),
      },
      body: JSON.stringify({ refresh_token: this.config.refresh_token }),
    });

    if (resp.status !== 200) {
      throw new Error(`refresh failed with status ${resp.status}`);
    }

    const data = (await resp.json()) as {
      access_token: string;
      refresh_token: string;
      expires_in: number;
    };

    this.config.access_token = data.access_token;
    this.config.refresh_token = data.refresh_token;
    this.config.expires_at = Math.floor(Date.now() / 1000) + data.expires_in;

    saveConfig(this.config);
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
