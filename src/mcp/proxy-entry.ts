/** The command an AI tool's MCP config runs to start the local proxy, `dosu mcp serve`
 * (proxy.ts). Every provider writes this instead of a remote-HTTP entry when it can: only a
 * local process knows the project, branch, and agent a request comes from. */

import { platform } from "node:os";
import { getBackendURL } from "../config/constants";
import { selfInvocation } from "../sync/detach";
import { findOnPath, launcherPathEnv } from "./detect";

export interface ProxyCommand {
  command: string;
  args: string[];
  env: Record<string, string>;
}

/** The agent each provider's proxy reports as x-dosu-client: the trajectory source its sessions
 * ship under where that differs from the provider id, so pulled memory ranks by the same agent
 * scope its evidence was stored with. */
const CLIENT_IDS: Record<string, string> = { claude: "claude-code" };

function clientId(providerId: string): string {
  return CLIENT_IDS[providerId] ?? providerId;
}

/** A backend override the entry is written under. The remote entries this replaces baked the
 * endpoint URL in, so a setup run against staging kept talking to staging; this keeps that. */
function pinnedBackend(): Record<string, string> {
  const url = process.env.DOSU_BACKEND_URL_OVERRIDE;
  return url ? { DOSU_BACKEND_URL_OVERRIDE: url } : {};
}

/** How `providerId`'s agent starts the proxy; null when there is no stable `dosu` to run (none on
 * PATH, as after a one-off `npx @dosu/cli setup`), and the provider writes its remote entry.
 *
 * The command is absolute and the entry carries its own PATH because GUI hosts (Cursor, Claude
 * Desktop, Codex desktop) spawn servers with the minimal launchd PATH. Dev installs run this
 * working copy, with the endpoints it was set up against, as dev hooks do. */
export function proxyCommand(providerId: string): ProxyCommand | null {
  const args = ["mcp", "serve", "--client", clientId(providerId)];
  if (process.env.DOSU_DEV === "true") {
    const { command, baseArgs } = selfInvocation();
    return {
      command,
      args: [...baseArgs, ...args],
      env: { DOSU_DEV: "true", DOSU_BACKEND_URL_OVERRIDE: getBackendURL() },
    };
  }
  /* v8 ignore next -- platform dispatch, win32 arm not exercised on POSIX CI */
  const dosu = findOnPath(platform() === "win32" ? "dosu.cmd" : "dosu");
  if (!dosu) return null;
  return { command: dosu, args, env: { PATH: launcherPathEnv(dosu), ...pinnedBackend() } };
}

/** The usual JSON form of a stdio server: `{ command, args, env }`. */
// biome-ignore lint/suspicious/noExplicitAny: server entries are arbitrary JSON
export function stdioServer({ command, args, env }: ProxyCommand): Record<string, any> {
  return { command, args, env };
}
