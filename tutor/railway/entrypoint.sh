#!/bin/bash
set -euo pipefail

if [ "${PORT:-3782}" != "3782" ]; then
  echo "[Murikah Tutor] PORT must be set to 3782; got ${PORT:-<unset>}." >&2
  exit 1
fi

GATEWAY_PID=""
APP_PID=""
STATUS_FILE="/tmp/murikah-app-status.json"

terminate_children() {
  if [ -n "${APP_PID}" ] && kill -0 "${APP_PID}" 2>/dev/null; then
    kill -TERM "${APP_PID}" 2>/dev/null || true
  fi
  if [ -n "${GATEWAY_PID}" ] && kill -0 "${GATEWAY_PID}" 2>/dev/null; then
    kill -TERM "${GATEWAY_PID}" 2>/dev/null || true
  fi
}

trap 'terminate_children; exit 143' TERM
trap 'terminate_children; exit 130' INT

if [ "${MURIKAH_EDGE_GATEWAY:-0}" = "1" ]; then
  : "${MURIKAH_TUTOR_APP_PORT:=3783}"
  export MURIKAH_TUTOR_APP_PORT
  node /app/murikah-edge-gateway.js &
  GATEWAY_PID=$!

  # The Cloudflare-facing port must exist before any heavier Python/bootstrap
  # work begins. This is deliberately a hard invariant: learners should never
  # wait on the Next.js/Python cold-start path just to receive a response.
  python - <<'PY'
import socket
import time

for _ in range(60):
    try:
        with socket.create_connection(("127.0.0.1", 3782), timeout=0.15):
            break
    except OSError:
        time.sleep(0.05)
else:
    raise SystemExit("Murikah edge gateway did not bind port 3782")
PY
fi

python /app/murikah-tutor-bootstrap.py

if [ "${MURIKAH_EDGE_GATEWAY:-0}" != "1" ]; then
  # Existing Codespaces/Railway behaviour remains unchanged.
  exec /app/entrypoint.sh
fi

restart_count=0
while :; do
  restart_count=$((restart_count + 1))
  printf '{"restartCount":%d,"lastExitCode":null,"lastChange":"%s"}\n' \
    "$restart_count" "$(date -u +%Y-%m-%dT%H:%M:%SZ)" > "$STATUS_FILE"

  /app/entrypoint.sh &
  APP_PID=$!
  set +e
  wait "$APP_PID"
  app_status=$?
  set -e
  APP_PID=""

  printf '{"restartCount":%d,"lastExitCode":%d,"lastChange":"%s"}\n' \
    "$restart_count" "$app_status" "$(date -u +%Y-%m-%dT%H:%M:%SZ)" > "$STATUS_FILE"
  echo "[Murikah Tutor] DeepTutor runtime exited with code ${app_status}; retrying behind the live gateway." >&2
  sleep 2
done
