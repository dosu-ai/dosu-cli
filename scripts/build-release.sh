#!/bin/bash
set -euo pipefail

VERSION="${1:?Version argument required}"
COMMIT="${2:-$(git rev-parse HEAD)}"

echo "==> Building release v${VERSION} (${COMMIT})"

rm -rf dist

# Build cross-platform binaries for direct GitHub release downloads
DOSU_VERSION="$VERSION" DOSU_INSTALL_CHANNEL=binary \
  bun --env-file=.env.production run scripts/build-all.ts

# Build Homebrew-specific binaries (same targets, channel baked as "homebrew")
DOSU_VERSION="$VERSION" DOSU_INSTALL_CHANNEL=homebrew DOSU_OUTPUT_SUFFIX=-homebrew \
  bun --env-file=.env.production run scripts/build-all.ts

# Bun's embedded macOS signature can fail verification and cause a launch-time
# SIGKILL. Sign both download and Homebrew binaries before archiving them.
bash scripts/sign-macos-binaries.sh \
  dist/dosu-darwin-arm64 dist/dosu-darwin-x64 \
  dist/dosu-darwin-arm64-homebrew dist/dosu-darwin-x64-homebrew
./dist/dosu-darwin-arm64 --version
./dist/dosu-darwin-arm64-homebrew --version

# Create archives
cd dist
for f in dosu-*; do
  if [[ "$f" == *.exe ]]; then
    zip "${f%.exe}.zip" "$f"
  else
    tar czf "${f}.tar.gz" "$f"
  fi
done

echo ""
echo "==> Release archives:"
ls -lh ./*.tar.gz ./*.zip
