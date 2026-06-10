#!/usr/bin/env bash
set -euo pipefail

SESSION_NAME="${MESSAGES_ASSISTANT_SESSION:-messages-assistant}"

screen_session_exists() {
  local sessions
  sessions="$(screen -list 2>/dev/null || true)"
  printf "%s\n" "$sessions" | awk '{print $1}' | grep -Eq "^[0-9]+[.]${SESSION_NAME}$"
}

monitor_pids() {
  ps -axo pid=,command= | awk '/messages-assistant|node src\/draft-monitor|src\/draft-monitor|run-draft-monitor-service|caffeinate .*draft-monitor/ && !/awk/ {print $1}'
}

if screen_session_exists; then
  screen -S "$SESSION_NAME" -X quit
fi

sleep 1
PIDS="$(monitor_pids)"
if [[ -n "$PIDS" ]]; then
  # shellcheck disable=SC2086
  kill $PIDS 2>/dev/null || true
  sleep 1
fi

PIDS="$(monitor_pids)"
if [[ -n "$PIDS" ]]; then
  # shellcheck disable=SC2086
  kill -9 $PIDS 2>/dev/null || true
fi

rm -rf "$(cd "$(dirname "$0")/.." && pwd)/data/draft-monitor.lock"
ps -axo pid,ppid,stat,command | rg 'messages-assistant|node src/draft-monitor|draft-monitor|messages-ax|caffeinate' || true
