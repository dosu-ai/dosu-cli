#!/usr/bin/env zsh
# Conductor workspace setup script for dosu-cli (Go CLI/TUI)

set -e

echo "Setting up Conductor workspace..."
echo "Root path: $CONDUCTOR_ROOT_PATH"
echo "Workspace path: $CONDUCTOR_WORKSPACE_PATH"

# =============================================================================
# Install Go dependencies
# =============================================================================

echo ""
echo "Installing Go dependencies..."
cd "$CONDUCTOR_WORKSPACE_PATH"
go mod download
echo "Go dependencies installed successfully!"

# =============================================================================
# Helper functions
# =============================================================================

# Copy a single file from root to workspace
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

# Copy a directory from root to workspace
copy_dir() {
    local relative_path="$1"
    local source="$CONDUCTOR_ROOT_PATH/$relative_path"
    local dest="$CONDUCTOR_WORKSPACE_PATH/$relative_path"

    if [ ! -d "$source" ]; then
        echo "  Warning: $relative_path not found in root, skipping"
        return 0
    fi

    mkdir -p "$dest"

    if ! rsync -a --delete "$source/" "$dest/"; then
        echo "  Warning: rsync failed for $relative_path"
        echo "           Continuing setup..."
        return 0
    fi

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
# Build binary to verify setup
# =============================================================================

echo ""
echo "Building binary to verify setup..."
make build
echo "Build successful!"

echo ""
echo "Conductor workspace setup complete!"
