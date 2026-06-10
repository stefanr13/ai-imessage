#!/usr/bin/env bash
set -euo pipefail

cd "$(dirname "$0")/.."
mkdir -p data

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

LOG_PATH="${DRAFT_MONITOR_SERVICE_LOG:-$PWD/data/draft-monitor.service.log}"
RESTART_DELAY_SECONDS="${DRAFT_MONITOR_RESTART_DELAY_SECONDS:-10}"
USE_CAFFEINATE="${USE_CAFFEINATE:-1}"

timestamp() {
  date -u +%Y-%m-%dT%H:%M:%SZ
}

echo "[$(timestamp)] service starting; log=$LOG_PATH"
while true; do
  echo "[$(timestamp)] monitor process starting; since=${SINCE_ISO:-${SINCE_LOCAL:-default}} allow_send=${ALLOW_SEND:-0}" >> "$LOG_PATH"
  set +e
  if [[ "$USE_CAFFEINATE" == "1" ]] && command -v caffeinate >/dev/null 2>&1; then
    caffeinate -dimsu "$NODE_BIN" src/draft-monitor.mjs >> "$LOG_PATH" 2>&1
  else
    "$NODE_BIN" src/draft-monitor.mjs >> "$LOG_PATH" 2>&1
  fi
  exit_code="$?"
  set -e
  echo "[$(timestamp)] monitor process exited with code $exit_code; restarting in ${RESTART_DELAY_SECONDS}s" >> "$LOG_PATH"
  sleep "$RESTART_DELAY_SECONDS"
done
