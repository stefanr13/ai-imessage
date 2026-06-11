#!/usr/bin/env bash
set -euo pipefail

cd "$(dirname "$0")/.."

SESSION_NAME="${MESSAGES_MOBILE_BRIDGE_SESSION:-messages-mobile-bridge}"
ENV_PATH="${MOBILE_BRIDGE_ENV:-$PWD/config/mobile-bridge.env}"
LOG_PATH="${MOBILE_BRIDGE_LOG:-$PWD/data/mobile-bridge.service.log}"
PORT_VALUE="${PORT:-8788}"
HOST_VALUE="${HOST:-0.0.0.0}"

screen_session_exists() {
  local sessions
  sessions="$(screen -list 2>/dev/null || true)"
  printf "%s\n" "$sessions" | awk '{print $1}' | grep -Eq "^[0-9]+[.]${SESSION_NAME}$"
}

if screen_session_exists; then
  echo "screen session ${SESSION_NAME} is already running" >&2
  exit 1
fi

mkdir -p "$(dirname "$ENV_PATH")" data

if [[ ! -f "$ENV_PATH" ]]; then
  umask 077
  {
    echo "BRIDGE_TOKEN=$(openssl rand -hex 32)"
    echo "HOST=${HOST_VALUE}"
    echo "PORT=${PORT_VALUE}"
    echo "ALLOW_SEND=1"
  } > "$ENV_PATH"
fi
chmod 600 "$ENV_PATH"

if ! grep -q '^ALLOW_SEND=' "$ENV_PATH"; then
  echo "ALLOW_SEND=1" >> "$ENV_PATH"
fi

set -a
# shellcheck disable=SC1090
source "$ENV_PATH"
set +a

if [[ -z "${BRIDGE_TOKEN:-}" ]]; then
  echo "BRIDGE_TOKEN is required in $ENV_PATH" >&2
  exit 1
fi

if lsof -ti "tcp:${PORT}" -sTCP:LISTEN >/dev/null 2>&1; then
  echo "port ${PORT} is already listening" >&2
  exit 1
fi

: > "$LOG_PATH"

screen -dmS "$SESSION_NAME" /bin/zsh -lc "
  cd '$PWD'
  set -a
  source '$ENV_PATH'
  set +a
  exec node server.mjs >> '$LOG_PATH' 2>&1
"

STARTED=0
for _ in 1 2 3 4 5 6 7 8 9 10; do
  if screen_session_exists && lsof -ti "tcp:${PORT}" -sTCP:LISTEN >/dev/null 2>&1; then
    STARTED=1
    break
  fi
  sleep 1
done

if [[ "$STARTED" != "1" ]]; then
  echo "mobile bridge did not stay running" >&2
  tail -n 80 "$LOG_PATH" >&2 || true
  exit 1
fi

echo "started session=${SESSION_NAME}"
echo "url=http://127.0.0.1:${PORT}/mobile/bootstrap"
echo "env=${ENV_PATH}"
echo "log=${LOG_PATH}"
echo "token=${BRIDGE_TOKEN}"
if [[ "${HOST}" == "0.0.0.0" ]]; then
  if command -v ipconfig >/dev/null 2>&1; then
    for iface in en0 en1; do
      address="$(ipconfig getifaddr "$iface" 2>/dev/null || true)"
      [[ -n "$address" ]] && echo "lan=http://${address}:${PORT}/mobile/bootstrap"
    done
  fi
fi
