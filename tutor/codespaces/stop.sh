#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
TUTOR_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
DATA_DIR="$TUTOR_ROOT/.codespaces-data"
DISABLE_MARKER="$DATA_DIR/.autostart-disabled"
CONTAINER="murikah-tutor-codespaces"
BOOTSTRAP_CONTAINER="${CONTAINER}-bootstrap"

mkdir -p "$DATA_DIR"
touch "$DISABLE_MARKER"

docker rm -f "$CONTAINER" "$BOOTSTRAP_CONTAINER" >/dev/null 2>&1 || true

echo "Murikah Tutor stopped. Persistent Codespaces test data was preserved."
echo "Automatic resume is disabled until you run: bash tutor/codespaces/start.sh"
