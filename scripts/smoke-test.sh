#!/usr/bin/env bash
set -euo pipefail

base_url="${BASE_URL:-http://localhost:8787}"
auth_header=()

if [[ -n "${BRIDGE_TOKEN:-}" ]]; then
  auth_header=(-H "Authorization: Bearer ${BRIDGE_TOKEN}")
fi

curl -fsS "${base_url}/health"
printf '\n'

curl -fsS \
  -X POST \
  "${auth_header[@]}" \
  -H "Content-Type: application/json" \
  -d '{"sender":"POC Test","messagePreview":"This is a dry-run trigger from curl."}' \
  "${base_url}/shortcut/message"
printf '\n'

curl -fsS "${auth_header[@]}" "${base_url}/events"
printf '\n'
