/**
 * tRPC client for calling the Dosu app's tRPC API.
 *
 * Uses `@trpc/client` with full AppRouter type safety.
 * Provides automatic token refresh via async headers + fetch-level 401 retry.
 */

import type { AppRouter } from "@dosu/api-types";
import { createTRPCClient, httpLink } from "@trpc/client";
import superjson from "superjson";
import { type Config, isTokenExpired } from "../config/config";
import { getWebAppURL } from "../config/constants";
import { logger } from "../debug/logger";
import { Client } from "./client";

export type { AppRouter };

/** Return type of createTypedClient — use this to type function parameters. */
export type TypedClient = ReturnType<typeof createTypedClient>;

/**
 * Create a type-safe tRPC client with full AppRouter type inference.
 *
 * Features:
 * - Proactive token refresh via async headers (checks expiry before each request)
 * - 401/403 retry via custom fetch (safety net for server-side token revocation)
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

  const httpClient = new Client(config);

  return createTRPCClient<AppRouter>({
    links: [
      httpLink({
        url: `${webAppURL}/api/trpc`,
        transformer: superjson,
        async headers() {
          if (isTokenExpired(config)) {
            logger.debug("trpc", "token expired, refreshing before request");
            try {
              await httpClient.refreshToken();
            } catch {
              throw new Error("session expired. Run 'dosu login' to re-authenticate");
            }
          }
          return { "Supabase-Access-Token": config.access_token };
        },
        async fetch(url, options) {
          const res = await globalThis.fetch(url, options);

          if (res.status === 401 || res.status === 403) {
            logger.debug("trpc", "got 401/403, attempting token refresh and retry");
            try {
              await httpClient.refreshToken();
            } catch {
              return res;
            }
            return globalThis.fetch(url, {
              ...options,
              headers: {
                ...(options?.headers as Record<string, string>),
                "Supabase-Access-Token": config.access_token,
              },
            });
          }

          return res;
        },
      }),
    ],
  });
}
