#!/usr/bin/env bash
set -euo pipefail

VERSION="${1:?Usage: build-npm.sh <version> [--dry-run]}"
DRY_RUN=""
if [[ "${2:-}" == "--dry-run" ]]; then
  DRY_RUN="--dry-run"
fi

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
NPM_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
DIST_DIR="${DIST_DIR:-dist}"

# Determine dist-tag: prerelease versions get "next", stable get "latest"
if [[ "$VERSION" == *-* ]]; then
  DIST_TAG="next"
else
  DIST_TAG="latest"
fi

echo "==> Publishing version $VERSION (dist-tag: $DIST_TAG)"

# Extract binaries into platform packages
# Format: "archive_name|package_dir|binary_name"
PLATFORMS="
dosu_Darwin_arm64.tar.gz|cli-darwin-arm64|dosu
dosu_Darwin_x86_64.tar.gz|cli-darwin-x64|dosu
dosu_Linux_arm64.tar.gz|cli-linux-arm64|dosu
dosu_Linux_x86_64.tar.gz|cli-linux-x64|dosu
dosu_Windows_x86_64.tar.gz|cli-win32-x64|dosu.exe
"

for entry in $PLATFORMS; do
  archive="$(echo "$entry" | cut -d'|' -f1)"
  pkg="$(echo "$entry" | cut -d'|' -f2)"
  bin_name="$(echo "$entry" | cut -d'|' -f3)"

  pkg_dir="$NPM_DIR/$pkg"
  bin_dir="$pkg_dir/bin"
  mkdir -p "$bin_dir"

  archive_path="$DIST_DIR/$archive"
  if [[ ! -f "$archive_path" ]]; then
    echo "ERROR: Archive not found: $archive_path"
    exit 1
  fi

  echo "  Extracting $archive -> $pkg/bin/$bin_name"
  tar -xzf "$archive_path" -C "$bin_dir" "$bin_name"
  chmod +x "$bin_dir/$bin_name"
done

# Update versions in all package.json files
echo "==> Updating versions to $VERSION"
for pkg_dir in "$NPM_DIR"/cli "$NPM_DIR"/cli-*; do
  if [[ -f "$pkg_dir/package.json" ]]; then
    jq --arg v "$VERSION" '.version = $v' "$pkg_dir/package.json" > "$pkg_dir/package.json.tmp"
    mv "$pkg_dir/package.json.tmp" "$pkg_dir/package.json"
  fi
done

# Update optionalDependencies versions in main package
jq --arg v "$VERSION" '
  .optionalDependencies |= with_entries(.value = $v)
' "$NPM_DIR/cli/package.json" > "$NPM_DIR/cli/package.json.tmp"
mv "$NPM_DIR/cli/package.json.tmp" "$NPM_DIR/cli/package.json"

# Publish platform packages first
echo "==> Publishing platform packages"
for pkg_dir in "$NPM_DIR"/cli-*; do
  pkg_name="$(jq -r .name "$pkg_dir/package.json")"
  echo "  Publishing $pkg_name@$VERSION"
  npm publish "$pkg_dir" --access public --tag "$DIST_TAG" $DRY_RUN
done

# Publish main package
echo "==> Publishing main package"
npm publish "$NPM_DIR/cli" --access public --tag "$DIST_TAG" $DRY_RUN

echo "==> Done! Published @dosu/cli@$VERSION (tag: $DIST_TAG)"
