#!/usr/bin/env bash
set -euo pipefail

SESSION_NAME="${CLOUDFLARE_TUNNEL_SESSION:-messages-cloudflare-tunnel}"

screen_session_exists() {
  local sessions
  sessions="$(screen -list 2>/dev/null || true)"
  printf "%s\n" "$sessions" | awk '{print $1}' | grep -Eq "^[0-9]+[.]${SESSION_NAME}$"
}

if screen_session_exists; then
  screen -S "$SESSION_NAME" -X quit
fi

sleep 1
screen -list || true
