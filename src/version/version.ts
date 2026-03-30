/**
 * Version information — injected at build time or read from package.json.
 *
 * Equivalent to Go's internal/version/version.go
 */

export const VERSION = process.env.DOSU_VERSION ?? "dev";
export const COMMIT = process.env.DOSU_COMMIT ?? "none";
export const DATE = process.env.DOSU_DATE ?? "unknown";

/**
 * Returns a formatted version string.
 */
export function getVersionString(): string {
  return `dosu ${VERSION} (${COMMIT}, ${DATE})`;
}
