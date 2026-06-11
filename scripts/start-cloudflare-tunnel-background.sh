#!/usr/bin/env bash
set -euo pipefail

cd "$(dirname "$0")/.."

SESSION_NAME="${CLOUDFLARE_TUNNEL_SESSION:-messages-cloudflare-tunnel}"
ENV_PATH="${CLOUDFLARE_TUNNEL_ENV:-$PWD/config/cloudflare-tunnel.env}"
LOG_PATH="${CLOUDFLARE_TUNNEL_LOG:-$PWD/data/cloudflare-tunnel.service.log}"
CLOUDFLARED_BIN="${CLOUDFLARED_BIN:-$PWD/.bin/cloudflared}"

screen_session_exists() {
  local sessions
  sessions="$(screen -list 2>/dev/null || true)"
  printf "%s\n" "$sessions" | awk '{print $1}' | grep -Eq "^[0-9]+[.]${SESSION_NAME}$"
}

if screen_session_exists; then
  echo "screen session ${SESSION_NAME} is already running" >&2
  exit 1
fi

if [[ ! -x "$CLOUDFLARED_BIN" ]]; then
  if command -v cloudflared >/dev/null 2>&1; then
    CLOUDFLARED_BIN="$(command -v cloudflared)"
  else
    echo "cloudflared is required. Install it or place it at .bin/cloudflared." >&2
    exit 1
  fi
fi

mkdir -p "$(dirname "$ENV_PATH")" data

if [[ ! -f "$ENV_PATH" ]]; then
  umask 077
  {
    echo "# Store exactly one tunnel mode here."
    echo "# Dashboard-managed mode:"
    echo "# CLOUDFLARE_TUNNEL_TOKEN=..."
    echo ""
    echo "# Locally-managed named tunnel mode:"
    echo "# CLOUDFLARE_TUNNEL_NAME=messages-assistant"
    echo "# CLOUDFLARE_TUNNEL_CONFIG=$PWD/config/cloudflared/config.yml"
  } > "$ENV_PATH"
  chmod 600 "$ENV_PATH"
  echo "created template env=${ENV_PATH}" >&2
  echo "add CLOUDFLARE_TUNNEL_TOKEN from Cloudflare Zero Trust, or configure a named tunnel" >&2
  exit 1
fi

chmod 600 "$ENV_PATH"

set -a
# shellcheck disable=SC1090
source "$ENV_PATH"
set +a

if [[ -n "${CLOUDFLARE_TUNNEL_TOKEN:-}" ]]; then
  RUN_COMMAND="exec '$CLOUDFLARED_BIN' tunnel --no-autoupdate run --token \"\$CLOUDFLARE_TUNNEL_TOKEN\""
elif [[ -n "${CLOUDFLARE_TUNNEL_NAME:-}" ]]; then
  CONFIG_ARG=""
  if [[ -n "${CLOUDFLARE_TUNNEL_CONFIG:-}" ]]; then
    if [[ ! -f "$CLOUDFLARE_TUNNEL_CONFIG" ]]; then
      echo "CLOUDFLARE_TUNNEL_CONFIG does not exist: ${CLOUDFLARE_TUNNEL_CONFIG}" >&2
      exit 1
    fi
    CONFIG_ARG="--config '$CLOUDFLARE_TUNNEL_CONFIG'"
  fi
  RUN_COMMAND="exec '$CLOUDFLARED_BIN' tunnel ${CONFIG_ARG} --no-autoupdate run \"\$CLOUDFLARE_TUNNEL_NAME\""
else
  echo "set CLOUDFLARE_TUNNEL_TOKEN or CLOUDFLARE_TUNNEL_NAME in ${ENV_PATH}" >&2
  exit 1
fi

: > "$LOG_PATH"

screen -dmS "$SESSION_NAME" /bin/zsh -lc "
  cd '$PWD'
  set -a
  source '$ENV_PATH'
  set +a
  $RUN_COMMAND >> '$LOG_PATH' 2>&1
"

STARTED=0
for _ in 1 2 3 4 5 6 7 8 9 10; do
  if screen_session_exists; then
    STARTED=1
    break
  fi
  sleep 1
done

if [[ "$STARTED" != "1" ]]; then
  echo "Cloudflare tunnel did not stay running" >&2
  tail -n 120 "$LOG_PATH" >&2 || true
  exit 1
fi

echo "started session=${SESSION_NAME}"
echo "env=${ENV_PATH}"
echo "log=${LOG_PATH}"
