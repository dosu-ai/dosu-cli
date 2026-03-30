#!/usr/bin/env zsh
# Conductor run script: run dosu-cli in dev mode

set -e

cd "$CONDUCTOR_WORKSPACE_PATH"

echo "Starting dosu-cli dev mode..."
echo ""

exec bun run --watch src/index.ts
