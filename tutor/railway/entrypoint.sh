#!/bin/bash
set -euo pipefail

if [ "${PORT:-3782}" != "3782" ]; then
  echo "[Murikah Tutor] PORT must be set to 3782 on Railway; got ${PORT:-<unset>}." >&2
  exit 1
fi

python /app/murikah-tutor-bootstrap.py

# Hand off to DeepTutor's own production entrypoint after Murikah-specific
# first-boot security settings are persisted to /app/data.
exec /app/entrypoint.sh
