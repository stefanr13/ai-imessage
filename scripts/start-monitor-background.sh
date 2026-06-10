#!/usr/bin/env bash
set -euo pipefail

cd "$(dirname "$0")/.."

SESSION_NAME="${MESSAGES_ASSISTANT_SESSION:-messages-assistant}"
LOG_PATH="${DRAFT_MONITOR_SERVICE_LOG:-$PWD/data/draft-monitor.service.log}"
SINCE_ISO="${SINCE_ISO:-$(date -u +%Y-%m-%dT%H:%M:%SZ)}"
ALLOW_SEND="${ALLOW_SEND:-1}"
OLLAMA_TIMEOUT_MS="${OLLAMA_TIMEOUT_MS:-120000}"
OLLAMA_KEEP_ALIVE="${OLLAMA_KEEP_ALIVE:-30m}"
DRAFT_MONITOR_IDLE_LOG_EVERY_CYCLES="${DRAFT_MONITOR_IDLE_LOG_EVERY_CYCLES:-12}"
DRAFT_MONITOR_POLL_MS="${DRAFT_MONITOR_POLL_MS:-5000}"

screen_session_exists() {
  local sessions
  sessions="$(screen -list 2>/dev/null || true)"
  printf "%s\n" "$sessions" | awk '{print $1}' | grep -Eq "^[0-9]+[.]${SESSION_NAME}$"
}

monitor_process_exists() {
  ps -axo command= | awk '/messages-assistant|node src\/draft-monitor|src\/draft-monitor|run-draft-monitor-service|caffeinate .*draft-monitor/ && !/awk/ {found=1} END {exit found ? 0 : 1}'
}

lock_pid_alive() {
  [[ -f data/draft-monitor.lock/pid ]] || return 1
  local pid
  pid="$(cat data/draft-monitor.lock/pid)"
  kill -0 "$pid" 2>/dev/null
}

if screen_session_exists; then
  echo "screen session ${SESSION_NAME} is already running" >&2
  exit 1
fi

if monitor_process_exists; then
  echo "draft monitor process is already running" >&2
  exit 1
fi

./scripts/build-bridge.sh >/dev/null

ALLOW_SEND="$ALLOW_SEND" \
OLLAMA_TIMEOUT_MS="$OLLAMA_TIMEOUT_MS" \
CHECK_SEND_READY=1 \
node scripts/production-check.mjs >/tmp/messages-assistant-production-check.json

mkdir -p data
: > "$LOG_PATH"

screen -dmS "$SESSION_NAME" /bin/zsh -lc "
  cd '$PWD'
  export SINCE_ISO='$SINCE_ISO'
  export ALLOW_SEND='$ALLOW_SEND'
  export OLLAMA_TIMEOUT_MS='$OLLAMA_TIMEOUT_MS'
  export OLLAMA_KEEP_ALIVE='$OLLAMA_KEEP_ALIVE'
  export DRAFT_MONITOR_IDLE_LOG_EVERY_CYCLES='$DRAFT_MONITOR_IDLE_LOG_EVERY_CYCLES'
  export DRAFT_MONITOR_POLL_MS='$DRAFT_MONITOR_POLL_MS'
  exec ./scripts/run-draft-monitor-service.sh
"

STARTED=0
for _ in 1 2 3 4 5 6 7 8 9 10; do
  if screen_session_exists && monitor_process_exists && lock_pid_alive; then
    STARTED=1
    break
  fi
  sleep 1
done

if [[ "$STARTED" != "1" ]]; then
  echo "screen session ${SESSION_NAME} did not stay running" >&2
  tail -n 80 "$LOG_PATH" >&2 || true
  exit 1
fi

echo "started session=${SESSION_NAME}"
echo "since=${SINCE_ISO}"
echo "log=${LOG_PATH}"
echo "production_check=/tmp/messages-assistant-production-check.json"
