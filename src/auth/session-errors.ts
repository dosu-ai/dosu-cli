const SESSION_EXPIRED_CODE = "SESSION_EXPIRED";
const SESSION_PERSISTENCE_ERROR_CODE = "SESSION_PERSISTENCE_ERROR";
const SESSION_REFRESH_ERROR_CODE = "SESSION_REFRESH_ERROR";

export class SessionExpiredError extends Error {
  readonly code = SESSION_EXPIRED_CODE;

  constructor(options?: ErrorOptions) {
    super("Your Dosu session has expired. Run 'dosu login' to re-authenticate.", options);
    this.name = "SessionExpiredError";
  }
}

export class SessionPersistenceError extends Error {
  readonly code = SESSION_PERSISTENCE_ERROR_CODE;

  constructor(options?: ErrorOptions) {
    super(
      "Could not safely save refreshed Dosu credentials. Ensure the Dosu config directory is writable, then retry.",
      options,
    );
    this.name = "SessionPersistenceError";
  }
}

/** Unexpected refresh failures remain observable and must not be reported as an expired session. */
export class SessionRefreshError extends Error {
  readonly code = SESSION_REFRESH_ERROR_CODE;
  readonly status?: number;

  constructor(options: ErrorOptions & { status?: number } = {}) {
    const message = options.status
      ? `Could not refresh the Dosu session (authentication server returned status ${options.status}). Retry the command.`
      : "Could not reach the authentication server to refresh the Dosu session. Retry the command.";
    super(message, options);
    this.name = "SessionRefreshError";
    this.status = options.status;
  }
}
