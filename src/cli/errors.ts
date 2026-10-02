/** Errors the CLI reports as user mistakes rather than crashes. */

/** Bad input from the user. Telemetry records it as a validation error and never sends it to
 * Sentry; the message is printed as-is, so make it say how to fix the invocation. */
export class CliUsageError extends Error {
  readonly exitCode = 1;

  constructor(message: string) {
    super(message);
    this.name = "CliUsageError";
  }
}
