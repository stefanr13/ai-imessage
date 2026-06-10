#!/usr/bin/env bash
set -euo pipefail

cd "$(dirname "$0")/.."
SINCE_LOCAL="${SINCE_LOCAL:-1:13pm}" node src/draft-monitor.mjs "$@"
