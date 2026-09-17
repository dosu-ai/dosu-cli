/** Version injected at build time via --define; from source it falls back to package.json. */

function readPackageVersion(): string {
  try {
    return require("../../package.json").version;
    /* v8 ignore next 3 -- unreachable in test: package.json always exists */
  } catch {
    return "dev";
  }
}

export const VERSION = process.env.DOSU_VERSION ?? readPackageVersion();

/** Distribution channel baked in at build time. One of: "npm", "binary", "homebrew". */
export const INSTALL_CHANNEL = process.env.DOSU_INSTALL_CHANNEL ?? "npm";

/** npm exec/npx runs are ephemeral and must never be converted into global installs. */
export function isNpxInvocation(
  channel: string = INSTALL_CHANNEL,
  env: Readonly<Record<string, string | undefined>> = process.env,
): boolean {
  return channel === "npm" && (env.npm_lifecycle_event === "npx" || env.npm_command === "exec");
}

/** Returns a formatted version string, e.g. "dosu v0.3.1". */
export function getVersionString(): string {
  return `v${VERSION}`;
}
