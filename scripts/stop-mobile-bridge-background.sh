#!/usr/bin/env bash
set -euo pipefail

SESSION_NAME="${MESSAGES_MOBILE_BRIDGE_SESSION:-messages-mobile-bridge}"
ENV_PATH="${MOBILE_BRIDGE_ENV:-$(cd "$(dirname "$0")/.." && pwd)/config/mobile-bridge.env}"

screen_session_exists() {
  local sessions
  sessions="$(screen -list 2>/dev/null || true)"
  printf "%s\n" "$sessions" | awk '{print $1}' | grep -Eq "^[0-9]+[.]${SESSION_NAME}$"
}

PORT_VALUE=""
if [[ -f "$ENV_PATH" ]]; then
  # shellcheck disable=SC1090
  PORT_VALUE="$(source "$ENV_PATH" >/dev/null 2>&1; printf "%s" "${PORT:-}")"
fi

if screen_session_exists; then
  screen -S "$SESSION_NAME" -X quit
fi

sleep 1

if [[ -n "$PORT_VALUE" ]]; then
  PIDS="$(lsof -ti "tcp:${PORT_VALUE}" -sTCP:LISTEN 2>/dev/null || true)"
  if [[ -n "$PIDS" ]]; then
    # shellcheck disable=SC2086
    kill $PIDS 2>/dev/null || true
  fi
fi

screen -list || true
