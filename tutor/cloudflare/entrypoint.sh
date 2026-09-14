#!/bin/bash
set -euo pipefail

# Cloudflare Containers run the same Murikah Tutor image as Codespaces, but do
# not need supervisord's privilege-dropping layer. Start the two application
# services directly so a platform-specific supervisor/setuid failure cannot
# keep port 3782 permanently closed.

export PORT=3782
export FRONTEND_PORT=3782
export FRONTEND_HOST=0.0.0.0
export BACKEND_PORT=8001
export BACKEND_HOST=127.0.0.1
export BACKEND_WORKERS=1
export DEEPTUTOR_IGNORE_PROCESS_ENV_OVERRIDES=1

# DeepTutor signs login sessions with data/system/auth/auth_secret. Container
# disk is disposable, so restore the same Cloudflare-managed signing secret
# before any DeepTutor auth module can import and generate a replacement.
python - <<'PY'
from pathlib import Path
import os
import tempfile

secret = os.environ.get("MURIKAH_TUTOR_AUTH_SECRET", "").strip()
if len(secret) < 32:
    raise RuntimeError("MURIKAH_TUTOR_AUTH_SECRET is required and must be at least 32 characters.")

target = Path("/app/data/system/auth/auth_secret")
target.parent.mkdir(parents=True, exist_ok=True)
current = target.read_text(encoding="utf-8").strip() if target.exists() else ""
if current != secret:
    fd, temp_name = tempfile.mkstemp(prefix=".auth_secret.", dir=target.parent)
    try:
        with os.fdopen(fd, "w", encoding="utf-8") as handle:
            handle.write(secret + "\n")
            handle.flush()
            os.fsync(handle.fileno())
        os.chmod(temp_name, 0o600)
        os.replace(temp_name, target)
    finally:
        if os.path.exists(temp_name):
            os.unlink(temp_name)
else:
    os.chmod(target, 0o600)
print("[Murikah Tutor] Stable Cloudflare auth signing secret restored.")
PY

python /app/murikah-tutor-bootstrap.py

# Keep DeepTutor's own JSON-backed runtime settings as the source of truth.
python - <<'PY'
from pathlib import Path
from deeptutor.services.setup import init_user_directories
init_user_directories(Path('/app'))
PY

eval "$(python - <<'PY'
import shlex
from deeptutor.services.config import export_runtime_settings_to_env
for key, value in export_runtime_settings_to_env(overwrite=True).items():
    print(f"export {key}={shlex.quote(str(value))}")
PY
)"

# Cloudflare exposes only the frontend port. The Next.js proxy reaches FastAPI
# over loopback inside the same container.
export BACKEND_PORT=8001
export BACKEND_HOST=127.0.0.1
export FRONTEND_PORT=3782
export FRONTEND_HOST=0.0.0.0
export PORT=3782
export HOSTNAME=0.0.0.0
export DEEPTUTOR_API_BASE_URL="http://127.0.0.1:8001"

backend_pid=""
frontend_pid=""
cleanup() {
  trap - TERM INT EXIT
  if [ -n "${frontend_pid}" ] && kill -0 "${frontend_pid}" 2>/dev/null; then kill -TERM "${frontend_pid}" 2>/dev/null || true; fi
  if [ -n "${backend_pid}" ] && kill -0 "${backend_pid}" 2>/dev/null; then kill -TERM "${backend_pid}" 2>/dev/null || true; fi
  wait "${frontend_pid}" 2>/dev/null || true
  wait "${backend_pid}" 2>/dev/null || true
}
trap cleanup TERM INT EXIT

echo "[Murikah Tutor] Starting Cloudflare runtime: backend 127.0.0.1:8001, frontend 0.0.0.0:3782"
/app/start-backend.sh &
backend_pid=$!
/app/start-frontend.sh &
frontend_pid=$!

# If either long-running service exits, terminate the sibling and fail the
# container. Cloudflare can then restart a clean instance instead of leaving a
# half-alive VM that never becomes healthy.
set +e
wait -n "${backend_pid}" "${frontend_pid}"
exit_code=$?
set -e

echo "[Murikah Tutor] A Tutor service exited with code ${exit_code}; stopping container." >&2
cleanup
exit "${exit_code}"
