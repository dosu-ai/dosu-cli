interface ErrorLike {
  message?: unknown;
  data?: { code?: unknown; path?: unknown; httpStatus?: unknown };
}

/** Print an error that ends the process. The tRPC code/path/status is printed when present so
 * masked server messages (e.g. "[object Object]") stay diagnosable. */
export function printFatalError(err: unknown): void {
  const error = err as ErrorLike | null | undefined;
  console.error(error?.message ?? err);
  const data = error?.data;
  if (data && (data.code || data.path || data.httpStatus)) {
    const parts = [
      data.code && `code=${data.code}`,
      data.path && `path=${data.path}`,
      data.httpStatus && `status=${data.httpStatus}`,
    ].filter(Boolean);
    console.error(parts.join(" "));
  }
}
