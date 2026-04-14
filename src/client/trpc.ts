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

// Type import from main project — resolved via tsconfig paths.
// Will be replaced by @dosu/api-types npm package once published.
import type { AppRouter } from "@dosu/api/root";
import { createTRPCClient, httpLink } from "@trpc/client";
import type { SuperJSONResult } from "superjson";
import superjson from "superjson";
import type { Config } from "../config/config";
import { getWebAppURL } from "../config/constants";
import { logger } from "../debug/logger";

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
  if (!config.api_key) {
    throw new Error("API key not found. Run 'dosu setup' first.");
  }
  const apiKey = config.api_key;

  return createTRPCClient<AppRouter>({
    links: [
      httpLink({
        url: `${webAppURL}/api/trpc`,
        transformer: superjson,
        headers() {
          return { "X-Dosu-API-Key": apiKey };
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
  private apiKey: string;

  constructor(config: Config) {
    const webAppURL = getWebAppURL();
    if (!webAppURL) {
      throw new Error("Web app URL not configured");
    }
    if (!config.api_key) {
      throw new Error("API key not found. Run 'dosu setup' first.");
    }
    this.baseURL = `${webAppURL}/api/trpc`;
    this.apiKey = config.api_key;
  }

  /**
   * Call a tRPC query procedure (GET request).
   */
  async query<T = unknown>(procedure: string, input?: unknown): Promise<T> {
    let url = `${this.baseURL}/${procedure}`;
    if (input !== undefined) {
      const serialized = superjson.serialize(input);
      url += `?input=${encodeURIComponent(JSON.stringify(serialized))}`;
    }

    logger.debug("trpc", `GET ${procedure}`);

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 30_000);

    try {
      const resp = await fetch(url, {
        method: "GET",
        headers: {
          "X-Dosu-API-Key": this.apiKey,
        },
        signal: controller.signal,
      });

      return this.handleResponse<T>(resp, procedure);
    } finally {
      clearTimeout(timeout);
    }
  }

  /**
   * Call a tRPC mutation procedure (POST request).
   */
  async mutate<T = unknown>(procedure: string, input?: unknown): Promise<T> {
    const url = `${this.baseURL}/${procedure}`;
    const body = input !== undefined ? superjson.serialize(input) : undefined;

    logger.debug("trpc", `POST ${procedure}`);

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 30_000);

    try {
      const resp = await fetch(url, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-Dosu-API-Key": this.apiKey,
        },
        body: body ? JSON.stringify(body) : undefined,
        signal: controller.signal,
      });

      return this.handleResponse<T>(resp, procedure);
    } finally {
      clearTimeout(timeout);
    }
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
