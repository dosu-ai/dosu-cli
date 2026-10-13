/** A handled command failure: the handler throws it instead of calling `process.exit`, so the
 * error unwinds to `execute()`, which prints it, records one telemetry failure event, and exits.
 *
 * `code` is a stable, low-cardinality value that telemetry may send as `error_code`; the message
 * and detail lines are for the terminal only and never leave the machine. Every code here is an
 * expected account or input state, so telemetry reports it to analytics but not to Sentry.
 * Adding a code is a telemetry schema change: document it in docs/telemetry.md. */

export const COMMAND_ERROR_CODES = [
  // Account and saved-context prerequisites
  "NOT_LOGGED_IN",
  "NO_ORG_SELECTED",
  "NO_API_KEY",
  "NO_LIBRARY_SELECTED",
  "NO_DEPLOYMENT_SELECTED",
  // A saved or requested selection that does not resolve
  "ORG_UNAVAILABLE",
  "LIBRARY_UNAVAILABLE",
  "DEPLOYMENT_UNAVAILABLE",
  "SCOPE_MISMATCH",
  "DEPLOYMENT_NOT_FOUND",
  "DEPLOYMENT_AMBIGUOUS",
  "NOT_MCP_DEPLOYMENT",
  "REVIEW_ITEM_NOT_FOUND",
  // Bad flags or arguments; telemetry classifies this one as a validation error
  "INVALID_ARGUMENT",
] as const;

export type CommandErrorCode = (typeof COMMAND_ERROR_CODES)[number];

export class CommandError extends Error {
  readonly exitCode = 1;

  constructor(
    readonly code: CommandErrorCode,
    message: string,
    readonly details: readonly string[] = [],
  ) {
    super(message);
    this.name = "CommandError";
  }
}

export function isCommandError(error: unknown): error is CommandError {
  return error instanceof CommandError;
}
