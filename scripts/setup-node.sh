#!/usr/bin/env bash
set -euo pipefail

NODE_VERSION="${NODE_VERSION:-v24.16.0}"
NODE_DIST="${NODE_DIST:-latest-v24.x}"
ARCH="$(uname -m)"

case "$ARCH" in
  arm64) NODE_ARCH="darwin-arm64" ;;
  x86_64) NODE_ARCH="darwin-x64" ;;
  *)
    echo "Unsupported macOS architecture: $ARCH" >&2
    exit 1
    ;;
esac

case "$NODE_VERSION/$NODE_ARCH" in
  v24.16.0/darwin-arm64)
    EXPECTED_SHA256="e28ad5531b2aafe0ea555a51b2412c42fdc0f91a6a53fbd03ac93e3847e91389"
    ;;
  v24.16.0/darwin-x64)
    EXPECTED_SHA256="6b144acbcfdbca75a1366100ff96e6bf6a4fe666b88a4bda7bfbd0299c82cca2"
    ;;
  *)
    echo "No pinned checksum for $NODE_VERSION/$NODE_ARCH. Update scripts/setup-node.sh first." >&2
    exit 1
    ;;
esac

ARCHIVE="node-${NODE_VERSION}-${NODE_ARCH}.tar.xz"
URL="https://nodejs.org/dist/${NODE_DIST}/${ARCHIVE}"
INSTALL_ROOT="${NODE_INSTALL_ROOT:-$HOME/.local/opt}"
BIN_DIR="${NODE_BIN_DIR:-$HOME/.local/bin}"
TMP_DIR="$(mktemp -d)"
trap 'rm -rf "$TMP_DIR"' EXIT

mkdir -p "$INSTALL_ROOT" "$BIN_DIR"
curl -fL "$URL" -o "$TMP_DIR/$ARCHIVE"
ACTUAL_SHA256="$(shasum -a 256 "$TMP_DIR/$ARCHIVE" | awk '{print $1}')"
if [[ "$ACTUAL_SHA256" != "$EXPECTED_SHA256" ]]; then
  echo "Checksum mismatch for $ARCHIVE" >&2
  echo "expected=$EXPECTED_SHA256" >&2
  echo "actual=$ACTUAL_SHA256" >&2
  exit 1
fi

rm -rf "$INSTALL_ROOT/node-${NODE_VERSION}-${NODE_ARCH}"
tar -xJf "$TMP_DIR/$ARCHIVE" -C "$INSTALL_ROOT"
ln -sfn "$INSTALL_ROOT/node-${NODE_VERSION}-${NODE_ARCH}" "$INSTALL_ROOT/node-current"
ln -sfn "$INSTALL_ROOT/node-current/bin/node" "$BIN_DIR/node"
ln -sfn "$INSTALL_ROOT/node-current/bin/npm" "$BIN_DIR/npm"
ln -sfn "$INSTALL_ROOT/node-current/bin/npx" "$BIN_DIR/npx"

if [[ "${SETUP_NODE_WRITE_SHELL_PATH:-1}" != "0" ]]; then
  for profile in "$HOME/.zshenv" "$HOME/.zprofile" "$HOME/.zshrc"; do
    touch "$profile"
    if ! grep -Fq 'export PATH="$HOME/.local/bin:$PATH"' "$profile"; then
      {
        echo ""
        echo 'export PATH="$HOME/.local/bin:$PATH"'
      } >> "$profile"
    fi
  done
fi

echo "Installed Node $("${BIN_DIR}/node" --version) at ${BIN_DIR}/node"
echo "Linked npm $("${BIN_DIR}/npm" --version) at ${BIN_DIR}/npm"
