#!/bin/bash
set -euo pipefail

VERSION="${1:?Version argument required}"
COMMIT="${2:-$(git rev-parse HEAD)}"
DATE="$(date -u +%Y-%m-%dT%H:%M:%SZ)"

echo "==> Building release v${VERSION} (${COMMIT})"

# Build cross-platform binaries
DOSU_VERSION="$VERSION" DOSU_COMMIT="$COMMIT" DOSU_DATE="$DATE" \
  bun run scripts/build-all.ts

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
ls -lh *.tar.gz *.zip
