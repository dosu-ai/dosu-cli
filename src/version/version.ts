/**
 * Version information — injected at build time via --define.
 * When running from source (bun run dev), falls back to package.json.
 */

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

/**
 * Returns a formatted version string, e.g. "dosu v0.3.1".
 */
export function getVersionString(): string {
  return `v${VERSION}`;
}
