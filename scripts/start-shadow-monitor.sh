#!/usr/bin/env bash
set -euo pipefail

cd "$(dirname "$0")/.."

NODE_BIN="${NODE_BIN:-}"
if [[ -z "$NODE_BIN" ]]; then
  if command -v node >/dev/null 2>&1; then
    NODE_BIN="$(command -v node)"
  elif [[ -x "$PWD/.bin/node" ]]; then
    NODE_BIN="$PWD/.bin/node"
  else
    echo "Node.js was not found. Install Node 18+ or set NODE_BIN=/path/to/node." >&2
    exit 1
  fi
fi

SINCE_LOCAL="${SINCE_LOCAL:-12:00am}" "$NODE_BIN" src/shadow-monitor.mjs "$@"
