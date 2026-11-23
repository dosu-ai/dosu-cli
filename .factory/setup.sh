#!/usr/bin/env bash
# Prepares Factory's machine for this repository's checks, as CI does:
# the Bun version in .bun-version, then the locked dependencies.
set -euo pipefail

# Bump both when .bun-version changes (hash of bun-linux-x64.zip, from the
# release's SHASUMS256.txt).
BUN_PINNED=1.4.2
BUN_ZIP_SHA256=36368faef7527875d5ffa52e53cd48021741f2a83eb6208a8dd64068d422a913

want=$(tr -d '[:space:]' < .bun-version)

if [[ $(bun --version 2>/dev/null || true) == "$want" ]]; then
  echo "setup: bun $want already installed"
else
  if [[ $want != "$BUN_PINNED" ]]; then
    echo "setup: .bun-version is $want but .factory/setup.sh pins $BUN_PINNED;" \
      "update BUN_PINNED and BUN_ZIP_SHA256 in .factory/setup.sh" >&2
    exit 1
  fi
  echo "setup: installing bun $want to /usr/local/bin"
  tmp=$(mktemp -d)
  trap 'rm -rf "$tmp"' EXIT
  url="https://github.com/oven-sh/bun/releases/download/bun-v$want/bun-linux-x64.zip"
  curl -fsSL --retry 3 -o "$tmp/bun.zip" "$url" || exit 75
  echo "$BUN_ZIP_SHA256  $tmp/bun.zip" | sha256sum -c --quiet -
  unzip -q "$tmp/bun.zip" -d "$tmp"
  sudo install -m 0755 "$tmp/bun-linux-x64/bun" /usr/local/bin/bun
  sudo ln -sf bun /usr/local/bin/bunx
  hash -r
  if [[ $(command -v bun) != /usr/local/bin/bun ]]; then
    echo "setup: $(command -v bun) shadows /usr/local/bin/bun on PATH" >&2
    exit 1
  fi
fi

echo "setup: bun install --frozen-lockfile"
bun install --frozen-lockfile
