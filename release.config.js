/** @type {import('semantic-release').GlobalConfig} */
export default {
  branches: [
    "main",
    // Internal pre-release channels: commits to `alpha`/`beta` publish to npm
    // under the matching dist-tag, e.g. `0.11.0-alpha.1` / `0.11.0-beta.1`.
    // Users opt in via `npx @dosu/cli@alpha setup` (or `@beta`). Homebrew is
    // skipped for these (ci.yml — `update-homebrew` filters versions with `-`).
    { name: "alpha", prerelease: true },
    { name: "beta", prerelease: true },
  ],
  plugins: [
    "@semantic-release/commit-analyzer",
    "@semantic-release/release-notes-generator",
    "@semantic-release/changelog",
    ["@semantic-release/npm"],
    [
      "@semantic-release/exec",
      {
        // Sourcemap upload is observability, not a release artifact, so it is
        // deliberately fail-open: `sentry-cli --wait` blocks on Sentry's
        // server-side processing and gives up with `Failed to process files in
        // 300s`, which took down the whole 0.48.0 publish even though the
        // upload itself had already succeeded. A Sentry hiccup must never stop
        // us shipping to npm — the run log still carries the failure.
        prepareCmd:
          "bun run build:npm && (bun run upload:sourcemaps || echo '::warning::sentry sourcemap upload failed (non-fatal)') && bash scripts/build-release.sh ${nextRelease.version} ${nextRelease.gitHead}",
        successCmd:
          "echo 'released=true' >> $GITHUB_OUTPUT && echo 'version=${nextRelease.version}' >> $GITHUB_OUTPUT",
      },
    ],
    [
      "@semantic-release/github",
      {
        assets: [
          { path: "dist/*.tar.gz" },
          { path: "dist/*.zip" },
        ],
      },
    ],
    [
      "@semantic-release/git",
      {
        assets: ["package.json", "CHANGELOG.md"],
        message:
          "chore(release): ${nextRelease.version} [skip ci]\n\n${nextRelease.notes}",
      },
    ],
  ],
};
