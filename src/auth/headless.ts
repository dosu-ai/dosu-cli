/**
 * Detect whether the CLI is running in a headless / browser-less environment.
 *
 * Used to auto-select the ticket-poll login flow instead of the localhost
 * callback flow, which requires a reachable loopback address.
 */

export function isHeadless(): boolean {
  if (!process.stdin?.isTTY) return true;
  const { SSH_CLIENT, SSH_TTY, SSH_CONNECTION, CI, GITHUB_ACTIONS, CODESPACE_NAME } = process.env;
  return !!(SSH_CLIENT || SSH_TTY || SSH_CONNECTION || CI || GITHUB_ACTIONS || CODESPACE_NAME);
}
