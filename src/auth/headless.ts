/** Detect a headless / browser-less environment, used to auto-select the ticket-poll login flow
 * over the localhost callback flow. */

export function isHeadless(): boolean {
  if (!process.stdin?.isTTY) return true;
  const { SSH_CLIENT, SSH_TTY, SSH_CONNECTION, CI, GITHUB_ACTIONS, CODESPACE_NAME } = process.env;
  return !!(SSH_CLIENT || SSH_TTY || SSH_CONNECTION || CI || GITHUB_ACTIONS || CODESPACE_NAME);
}
