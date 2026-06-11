#!/usr/bin/env bash
set -euo pipefail

cd "$(dirname "$0")/.."

OS="$(uname -s)"
ARCH="$(uname -m)"

if [[ "$OS" != "Darwin" ]]; then
  echo "This installer currently supports macOS only. Install cloudflared manually for ${OS}." >&2
  exit 1
fi

case "$ARCH" in
  arm64)
    ASSET="cloudflared-darwin-arm64.tgz"
    ;;
  x86_64)
    ASSET="cloudflared-darwin-amd64.tgz"
    ;;
  *)
    echo "Unsupported macOS architecture: ${ARCH}" >&2
    exit 1
    ;;
esac

TMP_DIR="$(mktemp -d)"
trap 'rm -rf "$TMP_DIR"' EXIT

mkdir -p .bin

curl -fL --retry 3 \
  -o "$TMP_DIR/${ASSET}" \
  "https://github.com/cloudflare/cloudflared/releases/latest/download/${ASSET}"

tar -xzf "$TMP_DIR/${ASSET}" -C "$TMP_DIR"
install -m 0755 "$TMP_DIR/cloudflared" .bin/cloudflared

./.bin/cloudflared --version
