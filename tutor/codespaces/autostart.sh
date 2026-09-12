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
TUNNEL_SCRIPT="$SCRIPT_DIR/cloudflare-tunnel.sh"
SOURCE_REVISION_LABEL="com.murikah.tutor.source-revision"

log() {
  printf '[Murikah Tutor] %s\n' "$*"
}

start_tunnel_if_configured() {
  if [[ -f "$TUNNEL_SCRIPT" ]]; then
    if ! bash "$TUNNEL_SCRIPT" start; then
      log "Cloudflare Tunnel did not start; Tutor itself remains available locally."
    fi
  fi
}

source_revision() {
  local tutor_tree logo_blob
  tutor_tree="$(git -C "$MURIKAH_ROOT" rev-parse HEAD:tutor 2>/dev/null || true)"
  logo_blob="$(git -C "$MURIKAH_ROOT" rev-parse HEAD:docs/images/murikah_6.png 2>/dev/null || true)"
  if [[ -n "$tutor_tree" && -n "$logo_blob" ]]; then
    printf '%s-%s' "$tutor_tree" "$logo_blob"
  else
    printf 'unknown'
  fi
}

runtime_env_args() {
  RUNTIME_ENV_ARGS=(
    -e PORT=3782
    -e "MURIKAH_PUBLIC_BASE_URL=${MURIKAH_PUBLIC_BASE_URL:-https://tutor.murikah.com}"
    -e "MURIKAH_GUEST_PROMPT_LIMIT=${MURIKAH_GUEST_PROMPT_LIMIT:-7}"
  )
  for env_name in \
    MURIKAH_GOOGLE_CLIENT_ID \
    MURIKAH_GOOGLE_CLIENT_SECRET \
    MURIKAH_MICROSOFT_CLIENT_ID \
    MURIKAH_MICROSOFT_CLIENT_SECRET \
    MURIKAH_MICROSOFT_TENANT \
    MURIKAH_APPLE_CLIENT_ID \
    MURIKAH_APPLE_TEAM_ID \
    MURIKAH_APPLE_KEY_ID \
    MURIKAH_APPLE_PRIVATE_KEY \
    MURIKAH_APPLE_PRIVATE_KEY_B64; do
    if [[ -n "${!env_name:-}" ]]; then
      RUNTIME_ENV_ARGS+=(--env "$env_name")
    fi
  done
}

recreate_container() {
  runtime_env_args
  log "Recreating Tutor container from persisted data..."
  if ! docker run -d \
    --name "$CONTAINER" \
    --restart unless-stopped \
    -p 3782:3782 \
    -v "$DATA_DIR:/app/data" \
    "${RUNTIME_ENV_ARGS[@]}" \
    "$IMAGE" >/dev/null; then
    log "Container recreation failed; run start.sh manually for diagnostics."
    return 1
  fi
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

CURRENT_SOURCE_REVISION="$(source_revision)"
IMAGE_SOURCE_REVISION="$(docker image inspect -f '{{ index .Config.Labels "com.murikah.tutor.source-revision" }}' "$IMAGE" 2>/dev/null || true)"

# Rebuild when the checked-out Tutor source differs from the source used for
# the reusable image. This keeps fast Codespaces resumes without serving stale
# Tutor code after a pull/merge.
if ! docker image inspect "$IMAGE" >/dev/null 2>&1 || [[ "$IMAGE_SOURCE_REVISION" != "$CURRENT_SOURCE_REVISION" ]]; then
  if [[ -n "$IMAGE_SOURCE_REVISION" ]]; then
    log "Tutor source changed; rebuilding pinned image..."
  else
    log "Tutor image is missing or predates source tracking; rebuilding pinned image..."
  fi
  if ! docker build \
    --label "$SOURCE_REVISION_LABEL=$CURRENT_SOURCE_REVISION" \
    --file "$TUTOR_ROOT/Dockerfile.railway" \
    --tag "$IMAGE" \
    "$MURIKAH_ROOT"; then
    log "Image rebuild failed; run start.sh manually for diagnostics."
    exit 0
  fi
fi

CURRENT_IMAGE_ID="$(docker image inspect -f '{{.Id}}' "$IMAGE" 2>/dev/null || true)"

if docker container inspect "$CONTAINER" >/dev/null 2>&1; then
  CONTAINER_IMAGE_ID="$(docker inspect -f '{{.Image}}' "$CONTAINER" 2>/dev/null || true)"
  if [[ "$CONTAINER_IMAGE_ID" != "$CURRENT_IMAGE_ID" ]]; then
    log "Tutor image changed; replacing the stale container..."
    docker rm -f "$CONTAINER" >/dev/null 2>&1 || true
    recreate_container || exit 0
  elif [[ "$(docker inspect -f '{{.State.Running}}' "$CONTAINER" 2>/dev/null)" != "true" ]]; then
    log "Resuming existing Tutor container..."
    if ! docker start "$CONTAINER" >/dev/null; then
      log "Existing container could not be started; leaving manual recovery available."
      exit 0
    fi
  else
    log "Tutor container is already running and matches the current source."
  fi
else
  recreate_container || exit 0
fi

for _ in {1..90}; do
  if curl --fail --silent --show-error http://127.0.0.1:3782/health >/dev/null 2>&1; then
    log "Tutor resumed successfully on port 3782."
    start_tunnel_if_configured
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