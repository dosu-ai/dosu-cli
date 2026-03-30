#!/bin/sh
# Dosu CLI installer
# Usage: curl -fsSL https://raw.githubusercontent.com/dosu-ai/dosu-cli/main/install.sh | sh
#
# Detects OS/arch, downloads the latest release binary, and installs to ~/.local/bin or /usr/local/bin.
# Supports: macOS (arm64/x64), Linux (arm64/x64)

set -e

REPO="${DOSU_INSTALL_REPO:-dosu-ai/dosu-cli}"
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

detect_libc() {
  if [ "$OS" != "linux" ]; then
    echo ""
    return
  fi

  if [ -f /etc/alpine-release ]; then
    echo "musl"
    return
  fi

  if command -v ldd >/dev/null 2>&1 && ldd --version 2>&1 | grep -qi musl; then
    echo "musl"
    return
  fi

  if command -v getconf >/dev/null 2>&1 && getconf GNU_LIBC_VERSION >/dev/null 2>&1; then
    echo "glibc"
    return
  fi

  echo "glibc"
}

LIBC="$(detect_libc)"

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

if [ -n "$DOSU_INSTALL_VERSION" ]; then
  RELEASE_TAG="$DOSU_INSTALL_VERSION"
else
  echo "Fetching latest release..."

  if command -v curl >/dev/null 2>&1; then
    RELEASE_TAG=$(curl -fsSL "https://api.github.com/repos/$REPO/releases/latest" | grep '"tag_name"' | head -1 | sed 's/.*"tag_name": *"//;s/".*//')
  elif command -v wget >/dev/null 2>&1; then
    RELEASE_TAG=$(wget -qO- "https://api.github.com/repos/$REPO/releases/latest" | grep '"tag_name"' | head -1 | sed 's/.*"tag_name": *"//;s/".*//')
  else
    echo "Error: curl or wget is required"
    exit 1
  fi
fi

if [ -z "$RELEASE_TAG" ]; then
  echo "Error: Could not determine release tag"
  exit 1
fi

# --- Download ---

ASSET_SUFFIX=""
if [ "$OS" = "linux" ] && [ "$LIBC" = "musl" ]; then
  ASSET_SUFFIX="-musl"
fi

ASSET_BASENAME="${BINARY_NAME}-${OS}-${ARCH}${ASSET_SUFFIX}"
ASSET_NAME="${ASSET_BASENAME}.tar.gz"
LEGACY_ASSET_NAME=""
case "${OS}/${ARCH}" in
  darwin/arm64) LEGACY_ASSET_NAME="dosu_Darwin_arm64.tar.gz" ;;
  darwin/x64) LEGACY_ASSET_NAME="dosu_Darwin_x86_64.tar.gz" ;;
  linux/arm64) LEGACY_ASSET_NAME="dosu_Linux_arm64.tar.gz" ;;
  linux/x64) LEGACY_ASSET_NAME="dosu_Linux_x86_64.tar.gz" ;;
esac

download_asset() {
  URL="$1"
  DEST="$2"

  if command -v curl >/dev/null 2>&1; then
    curl -fsSL "$URL" -o "$DEST"
  else
    wget -q "$URL" -O "$DEST"
  fi
}

if [ "$OS" = "linux" ] && [ -n "$LIBC" ]; then
  echo "Detected libc: $LIBC"
fi

echo "Downloading $BINARY_NAME $RELEASE_TAG for $OS/$ARCH${ASSET_SUFFIX}..."

TMPDIR_DL=$(mktemp -d)
trap 'rm -rf "$TMPDIR_DL"' EXIT

DOWNLOAD_URL="https://github.com/$REPO/releases/download/${RELEASE_TAG}/${ASSET_NAME}"
EXTRACTED_PATH="$TMPDIR_DL/$ASSET_BASENAME"

if ! download_asset "$DOWNLOAD_URL" "$TMPDIR_DL/$ASSET_NAME"; then
  if [ -n "$LEGACY_ASSET_NAME" ]; then
    echo "Primary asset name not found, trying legacy release naming..."
    ASSET_NAME="$LEGACY_ASSET_NAME"
    DOWNLOAD_URL="https://github.com/$REPO/releases/download/${RELEASE_TAG}/${ASSET_NAME}"
    download_asset "$DOWNLOAD_URL" "$TMPDIR_DL/$ASSET_NAME"
    EXTRACTED_PATH="$TMPDIR_DL/$BINARY_NAME"
  else
    echo "Error: Could not download $DOWNLOAD_URL"
    exit 1
  fi
fi

# --- Extract and install ---

tar -xzf "$TMPDIR_DL/$ASSET_NAME" -C "$TMPDIR_DL"
chmod +x "$EXTRACTED_PATH"
mv "$EXTRACTED_PATH" "$INSTALL_DIR/$BINARY_NAME"

echo ""
echo "✓ Installed $BINARY_NAME $RELEASE_TAG to $INSTALL_DIR/$BINARY_NAME"

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
