#!/usr/bin/env zsh
# Conductor run script: watch for changes and auto-rebuild dosu-cli

set -e

cd "$CONDUCTOR_WORKSPACE_PATH"

# Ensure GOPATH/bin is in PATH
export PATH="$(go env GOPATH)/bin:$PATH"

# Ensure air is installed
if ! command -v air &> /dev/null; then
    echo "Installing air (Go hot-reload tool)..."
    go install github.com/air-verse/air@latest
fi

echo "Starting dosu-cli dev mode (hot-reload)..."
echo "Watching for file changes — binary output: ./bin/dosu"
echo ""

exec air -c .air.toml
