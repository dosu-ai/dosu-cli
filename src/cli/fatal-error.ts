import pc from "picocolors";
import { isCommandError } from "./command-error";

/** Vercel request IDs look like `sfo1::iad1::abcde-1695000000000-0123456789ab`. Anything else
 * (non-strings, spaces, control characters, overlong values) is dropped rather than echoed to a
 * terminal. */
const REQUEST_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9:._-]{0,127}$/;

function read(value: unknown, key: string): unknown {
  if ((typeof value !== "object" && typeof value !== "function") || value === null) {
    return undefined;
  }
  try {
    return Reflect.get(value, key);
  } catch {
    return undefined;
  }
}

function requestIdOf(data: unknown): string | undefined {
  const value = read(data, "requestId");
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return REQUEST_ID_PATTERN.test(trimmed) ? trimmed : undefined;
}

/** The tRPC `code=… path=… status=… request_id=…` line for an error, if it carries any of them.
 * The request ID matches the server log line and Sentry event; it is local diagnostics only and
 * is never added to telemetry. */
export function fatalErrorDiagnostics(err: unknown): string | undefined {
  const data = read(err, "data");
  if (!data) return undefined;
  const code = read(data, "code");
  const path = read(data, "path");
  const status = read(data, "httpStatus");
  const requestId = requestIdOf(data);
  const parts = [
    code && `code=${code}`,
    path && `path=${path}`,
    status && `status=${status}`,
    requestId && `request_id=${requestId}`,
  ].filter(Boolean);
  return parts.length > 0 ? parts.join(" ") : undefined;
}

/** Print an error that ends the process. The tRPC code/path/status/request ID is printed when
 * present so masked server messages (e.g. "[object Object]") stay diagnosable. A CommandError
 * prints as the handler used to print it before exiting: a red message and dim detail lines. */
export function printFatalError(err: unknown): void {
  if (isCommandError(err)) {
    console.error(pc.red(err.message));
    for (const line of err.details) console.error(pc.dim(line));
    return;
  }
  console.error(read(err, "message") ?? err);
  const diagnostics = fatalErrorDiagnostics(err);
  if (diagnostics) console.error(diagnostics);
}
