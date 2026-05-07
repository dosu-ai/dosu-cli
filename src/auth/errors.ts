export interface OAuthCallbackErrorDetails {
  error?: string;
  errorCode?: string;
  errorDescription?: string;
}

/** Thrown when /callback receives OAuth error params from the web side. */
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

  /** One-line message for CLI surfaces. */
  get userMessage(): string {
    const desc = this.errorDescription ?? this.message;
    if (this.errorCode === "bad_oauth_state" || /state/i.test(desc)) {
      return `Authentication failed: ${desc}. Run \`dosu login\` again.`;
    }
    return `Authentication failed: ${desc}`;
  }
}
