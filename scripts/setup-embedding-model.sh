#!/usr/bin/env bash
set -euo pipefail

MODEL="${EMBEDDING_MODEL:-nomic-embed-text}"

if ! command -v ollama >/dev/null 2>&1; then
  echo "ollama is required before installing the embedding model" >&2
  exit 1
fi

ollama pull "$MODEL"
ollama list | awk -v model="$MODEL" '$1 == model || $1 == model ":latest" { found=1 } END { exit found ? 0 : 1 }'

echo "embedding_model=${MODEL}"
