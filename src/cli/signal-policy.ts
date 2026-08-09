export const CLI_SIGNALS = ["SIGINT", "SIGTERM", "SIGHUP"] as const;

export type CliSignal = (typeof CLI_SIGNALS)[number];
export type CliSignalCleanup = (signal: CliSignal) => Promise<void> | void;
type ExitProcess = (code: number) => void;

const activeCleanups = new Set<CliSignalCleanup>();
let pendingDispatch: Promise<void> | undefined;

function exitCodeForSignal(signal: CliSignal): number {
  if (signal === "SIGINT") return 0;
  if (signal === "SIGTERM") return 143;
  return 129;
}

/**
 * Guard a short-lived operation whose children must be reaped before the CLI
 * exits. The returned function removes only this exact registration.
 */
export function registerCliSignalCleanup(cleanup: CliSignalCleanup): () => void {
  activeCleanups.add(cleanup);
  return () => {
    activeCleanups.delete(cleanup);
  };
}

/**
 * Keep ordinary prompt cancellation immediate, but wait for any active
 * guarded operation before exiting. Repeated signals share one cleanup pass.
 */
export function dispatchCliSignal(
  signal: CliSignal,
  exit: ExitProcess = (code) => process.exit(code),
): Promise<void> {
  if (pendingDispatch) return pendingDispatch;
  const cleanups = [...activeCleanups];
  if (cleanups.length === 0) {
    exit(exitCodeForSignal(signal));
    return Promise.resolve();
  }

  pendingDispatch = Promise.allSettled(
    cleanups.map((cleanup) => Promise.resolve().then(() => cleanup(signal))),
  )
    .then((results) => {
      exit(results.some((result) => result.status === "rejected") ? 1 : exitCodeForSignal(signal));
    })
    .finally(() => {
      pendingDispatch = undefined;
    });
  return pendingDispatch;
}

/** The long-lived MCP proxy owns signal forwarding to its child bridge. */
export function installsImmediateSigintHandler(argv: readonly string[]): boolean {
  const mcpIndex = argv.indexOf("mcp");
  return !(mcpIndex >= 0 && argv[mcpIndex + 1] === "proxy");
}
