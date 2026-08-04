/**
 * fetch for long-running requests (e.g. /ask, which responds only when the
 * synchronous research workflow finishes).
 *
 * Both runtimes impose a hidden ~300s timeout underneath any AbortSignal the
 * caller passes, which made `--timeout 600` die at ~5 minutes:
 * - Node's fetch (undici) aborts if response headers haven't arrived within
 *   `headersTimeout` (default 300s).
 * - Bun's fetch has a 300s idle/connection timeout of its own.
 *
 * This wrapper disables those runtime defaults so the caller's AbortSignal is
 * the only timeout in effect. Callers MUST pass a signal.
 */

export async function longFetch(url: string, init: RequestInit): Promise<Response> {
  if (process.versions.bun) {
    // Bun extension: `timeout: false` disables the default idle timeout.
    return fetch(url, { ...init, timeout: false } as RequestInit);
  }
  // Use the bundled undici's own fetch — Node's global fetch does not accept
  // a dispatcher constructed from a different undici copy.
  const { Agent, fetch: undiciFetch } = await import("undici");
  const dispatcher = new Agent({ headersTimeout: 0, bodyTimeout: 0 });
  return (await undiciFetch(url, {
    ...init,
    dispatcher,
  } as Parameters<typeof undiciFetch>[1])) as unknown as Response;
}
