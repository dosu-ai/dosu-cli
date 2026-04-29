/** @type {import('semantic-release').GlobalConfig} */
export default {
  branches: [
    "main",
    // Internal pre-release channel: commits to `alpha` publish to npm under
    // dist-tag `alpha`, e.g. `0.11.0-alpha.1`. Users opt in via
    // `npx @dosu/cli@alpha setup`. Homebrew is skipped for these (see
    // ci.yml — `update-homebrew` filters out versions containing `-`).
    { name: "alpha", prerelease: true },
  ],
  plugins: [
    "@semantic-release/commit-analyzer",
    "@semantic-release/release-notes-generator",
    "@semantic-release/changelog",
    ["@semantic-release/npm"],
    [
      "@semantic-release/exec",
      {
        prepareCmd:
          "bash scripts/build-release.sh ${nextRelease.version} ${nextRelease.gitHead}",
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
