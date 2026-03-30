#!/usr/bin/env zsh
# Conductor workspace setup script for dosu-cli (Bun/TypeScript)

set -e

echo "Setting up Conductor workspace..."
echo "Root path: $CONDUCTOR_ROOT_PATH"
echo "Workspace path: $CONDUCTOR_WORKSPACE_PATH"

cd "$CONDUCTOR_WORKSPACE_PATH"

# =============================================================================
# Install dependencies
# =============================================================================

echo ""
echo "Installing dependencies..."
bun install
echo "Dependencies installed successfully!"

# =============================================================================
# Helper functions
# =============================================================================

copy_env_file() {
    local relative_path="$1"
    local source="$CONDUCTOR_ROOT_PATH/$relative_path"
    local dest="$CONDUCTOR_WORKSPACE_PATH/$relative_path"

    if [ -f "$source" ]; then
        mkdir -p "$(dirname "$dest")"
        cp "$source" "$dest"
        echo "  Copied: $relative_path"
    fi
}

copy_dir() {
    local relative_path="$1"
    local source="$CONDUCTOR_ROOT_PATH/$relative_path"
    local dest="$CONDUCTOR_WORKSPACE_PATH/$relative_path"

    if [ ! -d "$source" ]; then
        return 0
    fi

    mkdir -p "$dest"
    rsync -a --delete "$source/" "$dest/" 2>/dev/null || true
    echo "  Synced: $relative_path"
}

# =============================================================================
# Copy environment files
# =============================================================================

echo ""
echo "Copying environment files..."
copy_env_file ".env"

# =============================================================================
# Copy development tool configurations
# =============================================================================

echo ""
echo "Copying development tool configurations..."
copy_dir ".claude"
copy_dir ".conductor"

if [ -d "$CONDUCTOR_ROOT_PATH/.vscode" ]; then
    copy_dir ".vscode"
fi

# =============================================================================
# Verify build
# =============================================================================

echo ""
echo "Verifying build..."
bun build --compile src/index.ts --outfile bin/dosu 2>/dev/null && rm -f bin/dosu
echo "Build verified!"

echo ""
echo "Conductor workspace setup complete!"
