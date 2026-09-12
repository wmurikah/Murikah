#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
TUTOR_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
MURIKAH_ROOT="$(cd "$TUTOR_ROOT/.." && pwd)"
DATA_DIR="$TUTOR_ROOT/.codespaces-data"
DISABLE_MARKER="$DATA_DIR/.autostart-disabled"
IMAGE="murikah-tutor:codespaces"
CONTAINER="murikah-tutor-codespaces"
BOOTSTRAP_CONTAINER="${CONTAINER}-bootstrap"
TUNNEL_SCRIPT="$SCRIPT_DIR/cloudflare-tunnel.sh"
PREBUILT_IMAGE_HELPER="$SCRIPT_DIR/prebuilt-image.sh"

if ! command -v docker >/dev/null 2>&1; then
  echo "Docker is unavailable. Create the Codespace using the 'Murikah Tutor' dev container configuration." >&2
  exit 1
fi

mkdir -p "$DATA_DIR"
rm -f "$DISABLE_MARKER"

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
SOURCE_REVISION="$(source_revision)"

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

if [[ ! -f "$PREBUILT_IMAGE_HELPER" ]]; then
  echo "[Murikah Tutor] Prebuilt-image helper is missing." >&2
  exit 1
fi
# shellcheck source=/dev/null
source "$PREBUILT_IMAGE_HELPER"

IMAGE_SOURCE_REVISION="$(docker image inspect -f '{{ index .Config.Labels "com.murikah.tutor.source-revision" }}' "$IMAGE" 2>/dev/null || true)"
if ! docker image inspect "$IMAGE" >/dev/null 2>&1 || [[ "$IMAGE_SOURCE_REVISION" != "$SOURCE_REVISION" ]]; then
  echo "[Murikah Tutor] Retrieving the prebuilt pinned production image..."
  if ! murikah_pull_prebuilt_image "$IMAGE" "$SOURCE_REVISION" 60 10; then
    echo "[Murikah Tutor] Matching prebuilt image was not published within 10 minutes." >&2
    echo "[Murikah Tutor] Check the 'Build Murikah Tutor image' GitHub Actions workflow, then run start.sh again." >&2
    exit 1
  fi
fi

# Only replace the current container after the exact new image is safely local.
docker rm -f "$CONTAINER" "$BOOTSTRAP_CONTAINER" >/dev/null 2>&1 || true

wait_for_health() {
  local container_name="$1"
  local attempts=90
  local sleep_seconds=2

  for ((i=1; i<=attempts; i++)); do
    if curl --fail --silent --show-error http://127.0.0.1:3782/health >/dev/null 2>&1; then
      return 0
    fi
    if ! docker ps --format '{{.Names}}' | grep -Fxq "$container_name"; then
      echo "[Murikah Tutor] Container stopped before becoming healthy." >&2
      docker logs "$container_name" 2>/dev/null || true
      return 1
    fi
    sleep "$sleep_seconds"
  done

  echo "[Murikah Tutor] Timed out waiting for /health." >&2
  docker logs "$container_name" 2>/dev/null || true
  return 1
}

AUTH_FILE="$DATA_DIR/user/settings/auth.json"
if [[ ! -f "$AUTH_FILE" ]]; then
  read -r -p "Admin username [admin]: " admin_username
  admin_username="${admin_username:-admin}"

  while true; do
    read -r -s -p "Choose a strong admin password (minimum 14 characters): " admin_password
    echo
    if [[ ${#admin_password} -ge 14 ]]; then
      break
    fi
    echo "Password must contain at least 14 characters." >&2
  done

  echo "[Murikah Tutor] Initialising protected authentication state..."
  docker run -d \
    --name "$BOOTSTRAP_CONTAINER" \
    -p 3782:3782 \
    -v "$DATA_DIR:/app/data" \
    "${RUNTIME_ENV_ARGS[@]}" \
    -e MURIKAH_TUTOR_ADMIN_USERNAME="$admin_username" \
    -e MURIKAH_TUTOR_ADMIN_PASSWORD="$admin_password" \
    "$IMAGE" >/dev/null

  unset admin_password
  wait_for_health "$BOOTSTRAP_CONTAINER"
  docker rm -f "$BOOTSTRAP_CONTAINER" >/dev/null
fi

echo "[Murikah Tutor] Starting the reusable test container..."
docker run -d \
  --name "$CONTAINER" \
  --restart unless-stopped \
  -p 3782:3782 \
  -v "$DATA_DIR:/app/data" \
  "${RUNTIME_ENV_ARGS[@]}" \
  "$IMAGE" >/dev/null

wait_for_health "$CONTAINER"

if [[ -f "$TUNNEL_SCRIPT" ]]; then
  bash "$TUNNEL_SCRIPT" start || echo "[Murikah Tutor] Cloudflare Tunnel did not start; Tutor itself remains healthy." >&2
fi

cat <<'EOF'

Murikah Tutor is healthy.

For private operator testing, use the forwarded port 3782 URL from the PORTS tab.
Keep the GitHub Codespaces port Private when Cloudflare Tunnel is configured.
Public access should use the named Cloudflare Tunnel hostname (for example tutor.murikah.com), not app.github.dev.

Tutor data is stored in tutor/.codespaces-data and is intentionally ignored by Git.
Stopping the Codespace preserves that directory; deleting the Codespace deletes its storage.
Production Tutor images are built by GitHub Actions and pulled into Codespaces; Codespaces no longer compiles the Next.js production bundle locally.
On future Codespace resumes, Tutor and a configured Cloudflare Tunnel start automatically after first-boot setup.

Stop Tutor and the Cloudflare Tunnel without deleting Tutor data or allowing automatic resume:
  bash tutor/codespaces/stop.sh
EOF
