import { INSTALL_CHANNEL } from "../version/version";

export const GLOBAL_INSTALL_REQUIRED_MESSAGE =
  "Project setup requires a globally installed Dosu CLI. Install Dosu globally with `curl -fsSL https://cli.dosu.dev/install | sh`, npm, or Homebrew, then run `dosu setup` again.";

/** A project MCP calls `dosu`, so an ephemeral npx-only setup would create a broken project. */
export function setupNeedsGlobalInstall(
  channel: string = INSTALL_CHANNEL,
  _env: Readonly<Record<string, string | undefined>> = process.env,
  entrypoint: string | undefined = process.argv[1],
  cwd: string = process.cwd(),
): boolean {
  if (channel !== "npm") return false;

  // npm lifecycle variables are inherited and therefore are not proof that
  // this CLI itself is temporary. Classify only the entrypoint locations used
  // by npm exec, pnpm dlx, bunx, or a project-local node_modules install.
  const normalizedEntrypoint = (entrypoint ?? "").replaceAll("\\", "/");
  const normalizedCwd = cwd.replaceAll("\\", "/").replace(/\/$/, "");
  const lowerEntrypoint = normalizedEntrypoint.toLowerCase();
  const lowerCwd = normalizedCwd.toLowerCase();

  if (
    /\/_npx\/[^/]+\/node_modules\//.test(lowerEntrypoint) ||
    /\/(?:pnpm|npm)(?:-cache)?\/(?:.*\/)?(?:dlx|tmp\/dlx-)[^/]*\//.test(lowerEntrypoint) ||
    /\/\.bun\/install\/(?:cache|tmp)\//.test(lowerEntrypoint) ||
    /\/node_modules\/\.bin\/dosu(?:\.(?:cmd|ps1))?$/.test(lowerEntrypoint)
  ) {
    return true;
  }

  const packageSegment = "/node_modules/@dosu/cli/";
  const packageIndex = lowerEntrypoint.indexOf(packageSegment);
  if (packageIndex === -1) return false;

  const projectRoot = lowerEntrypoint.slice(0, packageIndex);
  return lowerCwd === projectRoot || lowerCwd.startsWith(`${projectRoot}/`);
}
