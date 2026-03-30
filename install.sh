#!/bin/sh
# Dosu CLI installer
# Usage: curl -fsSL https://raw.githubusercontent.com/dosu-ai/dosu-cli/main/install.sh | sh
#
# Detects OS/arch, downloads the latest release binary, and installs to ~/.local/bin or /usr/local/bin.
# Supports: macOS (arm64/x64), Linux (arm64/x64)

set -e

REPO="dosu-ai/dosu-cli"
BINARY_NAME="dosu"

# --- Detect platform ---

detect_os() {
  case "$(uname -s)" in
    Darwin)  echo "darwin" ;;
    Linux)   echo "linux" ;;
    MINGW*|MSYS*|CYGWIN*) echo "windows" ;;
    *) echo "unsupported" ;;
  esac
}

detect_arch() {
  case "$(uname -m)" in
    x86_64|amd64)  echo "x64" ;;
    arm64|aarch64) echo "arm64" ;;
    *) echo "unsupported" ;;
  esac
}

OS="$(detect_os)"
ARCH="$(detect_arch)"

if [ "$OS" = "unsupported" ] || [ "$ARCH" = "unsupported" ]; then
  echo "Error: Unsupported platform: $(uname -s) $(uname -m)"
  echo "Supported: macOS (arm64/x64), Linux (arm64/x64)"
  exit 1
fi

if [ "$OS" = "windows" ]; then
  echo "Error: Windows is not supported via this installer."
  echo "Download the .exe from: https://github.com/$REPO/releases/latest"
  exit 1
fi

# --- Determine install directory ---

INSTALL_DIR=""
if [ -n "$DOSU_INSTALL_DIR" ]; then
  INSTALL_DIR="$DOSU_INSTALL_DIR"
elif [ -w /usr/local/bin ]; then
  INSTALL_DIR="/usr/local/bin"
else
  INSTALL_DIR="$HOME/.local/bin"
  mkdir -p "$INSTALL_DIR"
fi

# --- Fetch latest release tag ---

echo "Fetching latest release..."

if command -v curl >/dev/null 2>&1; then
  LATEST_TAG=$(curl -fsSL "https://api.github.com/repos/$REPO/releases/latest" | grep '"tag_name"' | head -1 | sed 's/.*"tag_name": *"//;s/".*//')
elif command -v wget >/dev/null 2>&1; then
  LATEST_TAG=$(wget -qO- "https://api.github.com/repos/$REPO/releases/latest" | grep '"tag_name"' | head -1 | sed 's/.*"tag_name": *"//;s/".*//')
else
  echo "Error: curl or wget is required"
  exit 1
fi

if [ -z "$LATEST_TAG" ]; then
  echo "Error: Could not determine latest release"
  exit 1
fi

# --- Download ---

ASSET_NAME="dosu-${OS}-${ARCH}.tar.gz"
DOWNLOAD_URL="https://github.com/$REPO/releases/download/${LATEST_TAG}/${ASSET_NAME}"

echo "Downloading $BINARY_NAME $LATEST_TAG for $OS/$ARCH..."

TMPDIR_DL=$(mktemp -d)
trap 'rm -rf "$TMPDIR_DL"' EXIT

if command -v curl >/dev/null 2>&1; then
  curl -fsSL "$DOWNLOAD_URL" -o "$TMPDIR_DL/$ASSET_NAME"
elif command -v wget >/dev/null 2>&1; then
  wget -q "$DOWNLOAD_URL" -O "$TMPDIR_DL/$ASSET_NAME"
fi

# --- Extract and install ---

tar -xzf "$TMPDIR_DL/$ASSET_NAME" -C "$TMPDIR_DL"
chmod +x "$TMPDIR_DL/$BINARY_NAME-$OS-$ARCH"
mv "$TMPDIR_DL/$BINARY_NAME-$OS-$ARCH" "$INSTALL_DIR/$BINARY_NAME"

echo ""
echo "✓ Installed $BINARY_NAME $LATEST_TAG to $INSTALL_DIR/$BINARY_NAME"

# --- Check PATH ---

case ":$PATH:" in
  *":$INSTALL_DIR:"*) ;;
  *)
    echo ""
    echo "⚠ $INSTALL_DIR is not in your PATH."
    SHELL_NAME="$(basename "$SHELL")"
    case "$SHELL_NAME" in
      zsh)  RC_FILE="~/.zshrc" ;;
      bash) RC_FILE="~/.bashrc" ;;
      fish) RC_FILE="~/.config/fish/config.fish" ;;
      *)    RC_FILE="your shell config" ;;
    esac
    echo "  Add it with:"
    echo ""
    if [ "$SHELL_NAME" = "fish" ]; then
      echo "    fish_add_path $INSTALL_DIR"
    else
      echo "    echo 'export PATH=\"$INSTALL_DIR:\$PATH\"' >> $RC_FILE"
    fi
    echo ""
    ;;
esac

echo ""
echo "Run '$BINARY_NAME --help' to get started."
