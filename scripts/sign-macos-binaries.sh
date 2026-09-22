#!/bin/bash
set -euo pipefail

if [[ "$(uname -s)" != Darwin ]]; then
  echo "macOS binaries must be signed on macOS" >&2
  exit 1
fi

if [[ "$#" -eq 0 ]]; then
  echo "Usage: $0 <macOS binary>..." >&2
  exit 1
fi

for binary in "$@"; do
  if [[ ! -f "$binary" ]]; then
    echo "Missing macOS binary: $binary" >&2
    exit 1
  fi
  codesign --force --sign - "$binary"
  codesign --verify --verbose=2 "$binary"
done
