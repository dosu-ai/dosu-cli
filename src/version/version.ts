/**
 * Version information — injected at build time via --define.
 * When running from source (bun run dev), falls back to package.json.
 */

function readPackageVersion(): string {
  try {
    return require("../../package.json").version ?? "dev";
  } catch {
    return "dev";
  }
}

export const VERSION = process.env.DOSU_VERSION ?? readPackageVersion();

/**
 * Returns a formatted version string, e.g. "dosu v0.3.1".
 */
export function getVersionString(): string {
  return `v${VERSION}`;
}
