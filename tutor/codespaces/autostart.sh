#!/usr/bin/env bash
set -u

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
TUTOR_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
MURIKAH_ROOT="$(cd "$TUTOR_ROOT/.." && pwd)"
DATA_DIR="$TUTOR_ROOT/.codespaces-data"
AUTH_FILE="$DATA_DIR/user/settings/auth.json"
DISABLE_MARKER="$DATA_DIR/.autostart-disabled"
IMAGE="murikah-tutor:codespaces"
CONTAINER="murikah-tutor-codespaces"

log() {
  printf '[Murikah Tutor] %s\n' "$*"
}

# A brand-new Codespace must still perform the interactive first-boot setup.
# postStartCommand is non-interactive, so never prompt for credentials here.
if [[ ! -f "$AUTH_FILE" ]]; then
  log "First-boot setup has not been completed; automatic start skipped."
  log "Run: bash tutor/codespaces/start.sh"
  exit 0
fi

# Respect an explicit manual stop across Codespace resumes.
if [[ -f "$DISABLE_MARKER" ]]; then
  log "Automatic start is disabled because Tutor was stopped manually."
  log "Run start.sh to re-enable it."
  exit 0
fi

if ! command -v docker >/dev/null 2>&1; then
  log "Docker is not available yet; automatic start skipped."
  exit 0
fi

# Docker-in-Docker can take a moment to become ready after a Codespace resumes.
for _ in {1..30}; do
  if docker info >/dev/null 2>&1; then
    break
  fi
  sleep 2
done

if ! docker info >/dev/null 2>&1; then
  log "Docker did not become ready; automatic start skipped."
  exit 0
fi

# If the reusable container survived in Docker state, starting it is fastest.
if docker container inspect "$CONTAINER" >/dev/null 2>&1; then
  if [[ "$(docker inspect -f '{{.State.Running}}' "$CONTAINER" 2>/dev/null)" != "true" ]]; then
    log "Resuming existing Tutor container..."
    if ! docker start "$CONTAINER" >/dev/null; then
      log "Existing container could not be started; leaving manual recovery available."
      exit 0
    fi
  else
    log "Tutor container is already running."
  fi
else
  # Some Codespaces resumes may restore the workspace but not Docker objects.
  # Rebuild only when necessary; persisted auth/settings remain under DATA_DIR.
  if ! docker image inspect "$IMAGE" >/dev/null 2>&1; then
    log "Tutor image is not present after resume; rebuilding pinned image..."
    if ! docker build \
      --file "$TUTOR_ROOT/Dockerfile.railway" \
      --tag "$IMAGE" \
      "$MURIKAH_ROOT"; then
      log "Image rebuild failed; run start.sh manually for diagnostics."
      exit 0
    fi
  fi

  log "Recreating Tutor container from persisted data..."
  if ! docker run -d \
    --name "$CONTAINER" \
    --restart unless-stopped \
    -p 3782:3782 \
    -v "$DATA_DIR:/app/data" \
    -e PORT=3782 \
    "$IMAGE" >/dev/null; then
    log "Container recreation failed; run start.sh manually for diagnostics."
    exit 0
  fi
fi

for _ in {1..90}; do
  if curl --fail --silent --show-error http://127.0.0.1:3782/health >/dev/null 2>&1; then
    log "Tutor resumed successfully on port 3782."
    exit 0
  fi
  if ! docker ps --format '{{.Names}}' | grep -Fxq "$CONTAINER"; then
    log "Tutor stopped before becoming healthy."
    docker logs "$CONTAINER" 2>/dev/null || true
    exit 0
  fi
  sleep 2
done

log "Tutor did not become healthy within the resume window; run start.sh manually for diagnostics."
docker logs "$CONTAINER" 2>/dev/null || true
exit 0
