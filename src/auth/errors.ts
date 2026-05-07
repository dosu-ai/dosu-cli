/**
 * OAuth-specific errors thrown by the auth subsystem.
 */

export interface OAuthCallbackErrorDetails {
  error?: string;
  errorCode?: string;
  errorDescription?: string;
}

/**
 * Thrown when the local /callback listener receives an OAuth error from the
 * web side (e.g. Supabase rejected the OAuth state because it expired).
 *
 * Callers can `instanceof OAuthCallbackError` to print a curated message
 * instead of falling through to the generic "auth failed" path.
 */
export class OAuthCallbackError extends Error {
  readonly error?: string;
  readonly errorCode?: string;
  readonly errorDescription?: string;

  constructor(message: string, details: OAuthCallbackErrorDetails = {}) {
    super(message);
    this.name = "OAuthCallbackError";
    this.error = details.error;
    this.errorCode = details.errorCode;
    this.errorDescription = details.errorDescription;
  }

  /**
   * Tells the user what to do. Most CLI surfaces just want this one line.
   */
  get userMessage(): string {
    const desc = this.errorDescription ?? this.message;
    if (this.errorCode === "bad_oauth_state" || /state/i.test(desc)) {
      return `Authentication failed: ${desc}. Run \`dosu login\` again.`;
    }
    return `Authentication failed: ${desc}`;
  }
}
