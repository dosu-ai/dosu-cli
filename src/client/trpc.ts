/**
 * tRPC HTTP client for calling the main Dosu app's tRPC API.
 *
 * Two client implementations:
 * 1. `TrpcClient` — raw HTTP client (string-based procedure names, no type safety)
 * 2. `createTypedClient()` — @trpc/client with full AppRouter type safety
 *
 * Command files should migrate from TrpcClient to createTypedClient() for
 * compile-time procedure name and input schema validation.
 */

import type { AppRouter } from "@dosu/api-types";
import { createTRPCClient, httpLink } from "@trpc/client";
import type { SuperJSONResult } from "superjson";
import superjson from "superjson";
import { type Config, isTokenExpired } from "../config/config";
import { getWebAppURL } from "../config/constants";
import { logger } from "../debug/logger";
import { Client } from "./client";

export type { AppRouter };

/**
 * Create a type-safe tRPC client with full AppRouter type inference.
 *
 * Usage:
 * ```typescript
 * const client = createTypedClient(config);
 * const threads = await client.thread.list.query({ space_id: "..." });
 * const result = await client.page.create.mutate({ title: "...", body: "..." });
 * ```
 */
export function createTypedClient(config: Config) {
  const webAppURL = getWebAppURL();
  if (!webAppURL) {
    throw new Error("Web app URL not configured");
  }
  if (!config.access_token) {
    throw new Error("Not authenticated. Run 'dosu login' first.");
  }

  return createTRPCClient<AppRouter>({
    links: [
      httpLink({
        url: `${webAppURL}/api/trpc`,
        transformer: superjson,
        headers() {
          return { "Supabase-Access-Token": config.access_token };
        },
      }),
    ],
  });
}

/** tRPC HTTP response envelope. */
interface TrpcResponseEnvelope {
  result?: { data?: SuperJSONResult };
  error?: {
    message?: string;
    code?: number;
    data?: { code?: string; zodError?: unknown };
  };
}

export class TrpcError extends Error {
  code: string;

  constructor(message: string, code: string) {
    super(message);
    this.name = "TrpcError";
    this.code = code;
  }
}

export class TrpcClient {
  private baseURL: string;
  private config: Config;

  constructor(config: Config) {
    const webAppURL = getWebAppURL();
    if (!webAppURL) {
      throw new Error("Web app URL not configured");
    }
    if (!config.access_token) {
      throw new Error("Not authenticated. Run 'dosu login' first.");
    }
    this.baseURL = `${webAppURL}/api/trpc`;
    this.config = config;
  }

  private async refreshToken(): Promise<void> {
    await new Client(this.config).refreshToken();
  }

  private async doRequest(
    method: "GET" | "POST",
    procedure: string,
    input?: unknown,
  ): Promise<Response> {
    if (!this.config.access_token) {
      throw new Error("Not authenticated. Run 'dosu login' first.");
    }

    if (isTokenExpired(this.config)) {
      try {
        await this.refreshToken();
      } catch {
        throw new Error("session expired. Run 'dosu login' to re-authenticate");
      }
    }

    let resp = await this.doRequestOnce(method, procedure, input);

    if (resp.status === 401 || resp.status === 403) {
      try {
        await this.refreshToken();
      } catch {
        throw new Error("session expired. Run 'dosu login' to re-authenticate");
      }
      resp = await this.doRequestOnce(method, procedure, input);
    }

    return resp;
  }

  private async doRequestOnce(
    method: "GET" | "POST",
    procedure: string,
    input?: unknown,
  ): Promise<Response> {
    const headers: Record<string, string> = {
      "Supabase-Access-Token": this.config.access_token,
    };

    let url = `${this.baseURL}/${procedure}`;
    let body: string | undefined;

    if (method === "GET") {
      if (input !== undefined) {
        const serialized = superjson.serialize(input);
        url += `?input=${encodeURIComponent(JSON.stringify(serialized))}`;
      }
    } else {
      headers["Content-Type"] = "application/json";
      if (input !== undefined) {
        body = JSON.stringify(superjson.serialize(input));
      }
    }

    logger.debug("trpc", `${method} ${procedure}`);

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 30_000);

    try {
      return await fetch(url, {
        method,
        headers,
        body,
        signal: controller.signal,
      });
    } finally {
      clearTimeout(timeout);
    }
  }

  /**
   * Call a tRPC query procedure (GET request).
   */
  async query<T = unknown>(procedure: string, input?: unknown): Promise<T> {
    const resp = await this.doRequest("GET", procedure, input);
    return this.handleResponse<T>(resp, procedure);
  }

  /**
   * Call a tRPC mutation procedure (POST request).
   */
  async mutate<T = unknown>(procedure: string, input?: unknown): Promise<T> {
    const resp = await this.doRequest("POST", procedure, input);
    return this.handleResponse<T>(resp, procedure);
  }

  private async handleResponse<T>(resp: Response, procedure: string): Promise<T> {
    const text = await resp.text();

    let parsed: TrpcResponseEnvelope;
    try {
      parsed = JSON.parse(text) as TrpcResponseEnvelope;
    } catch {
      throw new TrpcError(
        `Invalid response from ${procedure}: ${text.slice(0, 200)}`,
        "PARSE_ERROR",
      );
    }

    if (parsed.error) {
      const msg = parsed.error.message ?? "Unknown error";
      const code = parsed.error.data?.code ?? "INTERNAL_SERVER_ERROR";
      logger.error("trpc", `${procedure} error: ${msg} (${code})`);
      throw new TrpcError(msg, code);
    }

    if (!parsed.result?.data) {
      throw new TrpcError(`No data in response from ${procedure}`, "EMPTY_RESPONSE");
    }

    // Deserialize SuperJSON response
    return superjson.deserialize(parsed.result.data) as T;
  }
}
