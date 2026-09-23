const FLUSH_TIMEOUT_MS = 2_000;

// Defaults that do not fit a CLI started only after a failure. ProcessSession would record every
// session as errored at the cost of an extra request. ContextLines and Modules read source files
// and package.json relative to the working directory, which for a CLI is the user's project.
const DROPPED_INTEGRATIONS = new Set(["ProcessSession", "ContextLines", "Modules"]);

/** Longest a failing command waits for its error report: SDK import and init, then the flush. */
export const ERROR_REPORT_TIMEOUT_MS = FLUSH_TIMEOUT_MS + 500;

export interface ErrorReport {
  dsn: string;
  error: unknown;
  release: string;
  tags: Record<string, string>;
  user?: { id: string; email?: string };
  /** Debug mode: print each envelope the SDK would send instead of sending it. */
  print?: (envelope: string) => void;
}

/** Report one command failure with the Sentry SDK. The SDK is imported here, on the error path
 * only, so successful commands never load it. */
export async function reportError(report: ErrorReport): Promise<void> {
  const Sentry = await import("@sentry/node");
  const { print } = report;
  Sentry.init({
    dsn: report.dsn,
    release: report.release,
    // Pin what the SDK would otherwise read from SENTRY_* variables a user may have set for their
    // own project: SENTRY_DEBUG logs to stdout, SENTRY_SPOTLIGHT forwards the event elsewhere.
    environment: "production",
    debug: false,
    spotlight: false,
    integrations: (defaults) =>
      defaults.filter((integration) => !DROPPED_INTEGRATIONS.has(integration.name)),
    ...(print
      ? {
          transport: (options) =>
            Sentry.createTransport(options, async ({ body }) => {
              print(typeof body === "string" ? body : new TextDecoder().decode(body));
              return {};
            }),
        }
      : {}),
  });
  Sentry.setTags(report.tags);
  if (report.user) Sentry.setUser(report.user);
  Sentry.captureException(report.error);
  await Sentry.flush(FLUSH_TIMEOUT_MS);
}
