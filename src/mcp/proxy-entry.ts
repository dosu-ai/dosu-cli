/** The command an AI tool's MCP config runs to start the local proxy, `dosu mcp serve`
 * (proxy.ts). Every provider writes this instead of a remote-HTTP entry when it can: only a
 * local process knows the project, branch, and agent a request comes from. */

import { realpathSync } from "node:fs";
import { platform } from "node:os";
import { basename } from "node:path";
import { getBackendURL } from "../config/constants";
import { type SelfInvocation, selfInvocation } from "../sync/detach";
import { allOnPath, findOnPath, launcherPathEnv } from "./detect";

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

/** A package runner's throwaway copy of the CLI: npx's cache, a bunx temp install, pnpm or Yarn
 * dlx. The runner may delete it any time, so no entry should run it. */
const THROWAWAY_COPY = /[\\/](?:_npx|bunx-[^\\/]*|dlx-[^\\/]*|pnpm[\\/]dlx)[\\/]/;

function realPath(path: string): string {
  try {
    return realpathSync(path);
  } catch {
    return path;
  }
}

/** `program` by the PATH entry that reaches it, when one does: a package manager's link (say
 * Homebrew's bin/dosu or bin/node) outlives the versioned file it points at, which is what the
 * runtime reports and what the next upgrade deletes. */
function stablePath(program: string): string {
  const real = realPath(program);
  return allOnPath(basename(program)).find((candidate) => realPath(candidate) === real) ?? program;
}

/** How to run the Dosu install doing the writing -- not whichever `dosu` is first on PATH, which
 * may be an older one without `mcp serve`. A compiled binary runs itself; the npm package runs
 * its script with the node running it now, by absolute path, so the entry never depends on a
 * `#!/usr/bin/env node` finding node on the PATH the agent gives it. Null for a throwaway copy. */
function runningInstall(): SelfInvocation | null {
  const { command, baseArgs } = selfInvocation();
  const program = baseArgs[0] ?? command;
  if (THROWAWAY_COPY.test(program) || THROWAWAY_COPY.test(realPath(program))) return null;
  return { command: stablePath(command), baseArgs };
}

/** How `providerId`'s agent starts the proxy; null when the CLI doing the writing is a package
 * runner's throwaway copy (a one-off `npx @dosu/cli setup`), and the provider writes its remote
 * entry.
 *
 * The command is absolute and the entry carries its own PATH because GUI hosts (Cursor, Claude
 * Desktop, Codex desktop) spawn servers with the minimal launchd PATH, and agents apply an entry's
 * PATH over their own. That PATH keeps the git the installing shell resolves, which reads the
 * project key. Dev installs run this working copy, with the endpoints it was set up against, as
 * dev hooks do. */
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
  const install = runningInstall();
  if (!install) return null;
  /* v8 ignore next -- platform dispatch, win32 arm not exercised on POSIX CI */
  const git = findOnPath(platform() === "win32" ? "git.exe" : "git");
  return {
    command: install.command,
    args: [...install.baseArgs, ...args],
    env: { PATH: launcherPathEnv(install.command, git), ...pinnedBackend() },
  };
}

/** The usual JSON form of a stdio server: `{ command, args, env }`. */
// biome-ignore lint/suspicious/noExplicitAny: server entries are arbitrary JSON
export function stdioServer({ command, args, env }: ProxyCommand): Record<string, any> {
  return { command, args, env };
}
