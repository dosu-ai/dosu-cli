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

/** An npm dist-tag Dosu publishes under (release.config.js). */
export type ReleaseTag = "latest" | "alpha" | "beta";

/** The dist-tag `version` was published under. A prerelease build keeps following its own
 * channel -- update checks and `dosu upgrade` read and install that tag -- so a beta install is
 * never silently moved onto `latest`, and everything else follows `latest`. */
export function releaseTag(version: string = VERSION): ReleaseTag {
  const match = /^\d+\.\d+\.\d+-(alpha|beta)(?:\.|$)/.exec(version);
  return match ? (match[1] as ReleaseTag) : "latest";
}

/** Distribution channel baked in at build time. One of: "npm", "binary", "homebrew", "selfhost". */
export const INSTALL_CHANNEL = process.env.DOSU_INSTALL_CHANNEL ?? "npm";

/** A build for a self-hosted Dosu backend, which ships its own CLI. Public releases point at Dosu
 * Cloud, so these builds never look for, offer, or install them. */
export function isSelfHostedBuild(channel: string = INSTALL_CHANNEL): boolean {
  return channel === "selfhost";
}

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
