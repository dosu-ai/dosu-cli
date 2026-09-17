/** Dependency-free argv checks for the status-line render fast path in `src/index.ts`. Nothing
 * else may be imported here: this module loads on every CLI invocation. */

export const RENDER_ARGV = ["knowledge", "statusline", "render"] as const;

/** Whether `argv` (process.argv) is a status-line render invocation. */
export function isStatuslineRenderArgv(argv: readonly string[]): boolean {
  return RENDER_ARGV.every((part, i) => argv[i + 2] === part);
}

/** `--agent <id>` or `--agent=<id>`; empty when absent (renders as off). */
export function agentFromArgv(argv: readonly string[]): string {
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--agent") return argv[i + 1] ?? "";
    if (arg.startsWith("--agent=")) return arg.slice("--agent=".length);
  }
  return "";
}
