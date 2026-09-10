#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
TUTOR_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
DATA_DIR="$TUTOR_ROOT/.codespaces-data"
SECRET_DIR="$DATA_DIR/.secrets"
TOKEN_FILE="$SECRET_DIR/cloudflare-tunnel-token"
NETWORK="murikah-tutor-net"
TUTOR_CONTAINER="murikah-tutor-codespaces"
TUNNEL_CONTAINER="murikah-tutor-cloudflared"
TUNNEL_IMAGE="cloudflare/cloudflared:latest"
ACTION="${1:-start}"

log() {
  printf '[Murikah Tutor Tunnel] %s\n' "$*"
}

ensure_docker() {
  if ! command -v docker >/dev/null 2>&1; then
    log "Docker is unavailable."
    return 1
  fi
  if ! docker info >/dev/null 2>&1; then
    log "Docker is not ready."
    return 1
  fi
}

ensure_network() {
  if ! docker network inspect "$NETWORK" >/dev/null 2>&1; then
    docker network create "$NETWORK" >/dev/null
  fi
  docker network connect "$NETWORK" "$TUTOR_CONTAINER" >/dev/null 2>&1 || true
}

write_token_file() {
  if [[ -z "${CLOUDFLARE_TUNNEL_TOKEN:-}" ]]; then
    return 1
  fi
  mkdir -p "$SECRET_DIR"
  umask 077
  printf '%s' "$CLOUDFLARE_TUNNEL_TOKEN" > "$TOKEN_FILE"
  chmod 600 "$TOKEN_FILE"
}

start_tunnel() {
  ensure_docker || return 1

  if ! docker ps --format '{{.Names}}' | grep -Fxq "$TUTOR_CONTAINER"; then
    log "Tutor is not running; tunnel start skipped."
    return 1
  fi

  if ! write_token_file; then
    log "CLOUDFLARE_TUNNEL_TOKEN is not configured; tunnel start skipped."
    log "Add it as a GitHub Codespaces secret scoped to wmurikah/Murikah."
    return 0
  fi

  ensure_network

  docker rm -f "$TUNNEL_CONTAINER" >/dev/null 2>&1 || true

  if ! docker image inspect "$TUNNEL_IMAGE" >/dev/null 2>&1; then
    log "Pulling cloudflared image..."
    docker pull "$TUNNEL_IMAGE" >/dev/null
  fi

  log "Starting named Cloudflare Tunnel..."
  docker run -d \
    --name "$TUNNEL_CONTAINER" \
    --restart unless-stopped \
    --network "$NETWORK" \
    -v "$TOKEN_FILE:/run/secrets/tunnel-token:ro" \
    "$TUNNEL_IMAGE" \
    tunnel --no-autoupdate run --token-file /run/secrets/tunnel-token >/dev/null

  sleep 3
  if ! docker ps --format '{{.Names}}' | grep -Fxq "$TUNNEL_CONTAINER"; then
    log "cloudflared stopped unexpectedly."
    docker logs "$TUNNEL_CONTAINER" 2>/dev/null || true
    return 1
  fi

  log "Cloudflare Tunnel connector is running."
  log "Cloudflare route service URL must be: http://$TUTOR_CONTAINER:3782"
}

stop_tunnel() {
  if command -v docker >/dev/null 2>&1; then
    docker rm -f "$TUNNEL_CONTAINER" >/dev/null 2>&1 || true
  fi
  log "Cloudflare Tunnel connector stopped."
}

status_tunnel() {
  ensure_docker || return 1
  if docker ps --format '{{.Names}}' | grep -Fxq "$TUNNEL_CONTAINER"; then
    log "Connector is running."
    docker ps --filter "name=$TUNNEL_CONTAINER"
    return 0
  fi
  log "Connector is not running."
  return 1
}

case "$ACTION" in
  start)
    start_tunnel
    ;;
  stop)
    stop_tunnel
    ;;
  restart)
    stop_tunnel
    start_tunnel
    ;;
  status)
    status_tunnel
    ;;
  logs)
    ensure_docker || exit 1
    docker logs --tail 100 "$TUNNEL_CONTAINER"
    ;;
  *)
    echo "usage: $0 {start|stop|restart|status|logs}" >&2
    exit 2
    ;;
esac
