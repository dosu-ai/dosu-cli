/** The installed status-line command's entry: read the payload from stdin, print one line. Kept
 * free of Commander and the rest of the CLI so `src/index.ts` can dispatch here before loading
 * anything else; harnesses re-run this every few hundred milliseconds. */

import { agentFromArgv, RENDER_ARGV } from "./argv";
import { renderStatusline } from "./render";

/** Drain stdin; an interactive terminal (nothing piped) reads as empty. Never throws. */
export async function readStdin(
  stdin: NodeJS.ReadStream & { isTTY?: boolean } = process.stdin,
): Promise<string> {
  if (stdin.isTTY) return "";
  try {
    let data = "";
    stdin.setEncoding("utf8");
    for await (const chunk of stdin) data += chunk;
    return data;
  } catch {
    return "";
  }
}

export interface RenderRunDeps {
  readStdin?: () => Promise<string>;
  render?: (raw: string, agentId: string) => string;
  write?: (line: string) => void;
}

/** Render for `agentId` from stdin and write the line. */
export async function runStatuslineRender(
  agentId: string,
  deps: RenderRunDeps = {},
): Promise<void> {
  const raw = await (deps.readStdin ?? readStdin)();
  const line = (deps.render ?? renderStatusline)(raw, agentId);
  (deps.write ?? ((text: string) => process.stdout.write(`${text}\n`)))(line);
}

/** Entry for the `src/index.ts` fast path: agent id from argv, payload from stdin. */
export function runStatuslineRenderFromArgv(
  argv: readonly string[] = process.argv,
  deps: RenderRunDeps = {},
): Promise<void> {
  return runStatuslineRender(agentFromArgv(argv.slice(2 + RENDER_ARGV.length)), deps);
}
