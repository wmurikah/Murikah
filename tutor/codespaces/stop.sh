#!/usr/bin/env bash
set -euo pipefail

CONTAINER="murikah-tutor-codespaces"
BOOTSTRAP_CONTAINER="${CONTAINER}-bootstrap"

docker rm -f "$CONTAINER" "$BOOTSTRAP_CONTAINER" >/dev/null 2>&1 || true

echo "Murikah Tutor stopped. Persistent Codespaces test data was preserved."
