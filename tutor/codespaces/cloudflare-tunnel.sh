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
TUNNEL_DNS_PRIMARY="1.1.1.1"
TUNNEL_DNS_SECONDARY="1.0.0.1"
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

edge_connection_registered() {
  docker logs --tail 500 "$TUNNEL_CONTAINER" 2>&1 | grep -Fq "Registered tunnel connection"
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

  # The token file remains mode 600. Run cloudflared with the same numeric
  # owner/group as that file so the container can read it without broadening
  # the token permissions or exposing the token through docker inspect.
  local token_uid token_gid
  token_uid="$(stat -c '%u' "$TOKEN_FILE")"
  token_gid="$(stat -c '%g' "$TOKEN_FILE")"

  log "Starting named Cloudflare Tunnel..."
  docker run -d \
    --name "$TUNNEL_CONTAINER" \
    --restart unless-stopped \
    --network "$NETWORK" \
    --dns "$TUNNEL_DNS_PRIMARY" \
    --dns "$TUNNEL_DNS_SECONDARY" \
    --user "$token_uid:$token_gid" \
    -v "$TOKEN_FILE:/run/secrets/tunnel-token:ro" \
    "$TUNNEL_IMAGE" \
    tunnel --no-autoupdate --protocol http2 run --token-file /run/secrets/tunnel-token >/dev/null

  # A process that merely remains running is not enough: wait until cloudflared
  # has actually registered at least one edge connection with Cloudflare.
  for _ in {1..30}; do
    if ! docker container inspect "$TUNNEL_CONTAINER" >/dev/null 2>&1; then
      log "cloudflared container disappeared unexpectedly."
      return 1
    fi

    local state restarting restart_count
    state="$(docker inspect -f '{{.State.Status}}' "$TUNNEL_CONTAINER")"
    restarting="$(docker inspect -f '{{.State.Restarting}}' "$TUNNEL_CONTAINER")"
    restart_count="$(docker inspect -f '{{.RestartCount}}' "$TUNNEL_CONTAINER")"

    if [[ "$state" != "running" || "$restarting" == "true" ]]; then
      log "cloudflared became unhealthy (state=$state, restarting=$restarting, restarts=$restart_count)."
      docker logs --tail 100 "$TUNNEL_CONTAINER" 2>/dev/null || true
      return 1
    fi

    if edge_connection_registered; then
      log "Cloudflare Tunnel connector is running and registered with the edge."
      log "Cloudflare route service URL must be: http://$TUTOR_CONTAINER:3782"
      return 0
    fi

    sleep 2
  done

  log "cloudflared stayed running but did not register a Cloudflare edge connection within 60 seconds."
  docker logs --tail 100 "$TUNNEL_CONTAINER" 2>/dev/null || true
  return 1
}

stop_tunnel() {
  if command -v docker >/dev/null 2>&1; then
    docker rm -f "$TUNNEL_CONTAINER" >/dev/null 2>&1 || true
  fi
  log "Cloudflare Tunnel connector stopped."
}

status_tunnel() {
  ensure_docker || return 1
  if ! docker container inspect "$TUNNEL_CONTAINER" >/dev/null 2>&1; then
    log "Connector is not running."
    return 1
  fi

  local state restarting restart_count
  state="$(docker inspect -f '{{.State.Status}}' "$TUNNEL_CONTAINER")"
  restarting="$(docker inspect -f '{{.State.Restarting}}' "$TUNNEL_CONTAINER")"
  restart_count="$(docker inspect -f '{{.RestartCount}}' "$TUNNEL_CONTAINER")"

  if [[ "$state" == "running" && "$restarting" != "true" ]]; then
    if edge_connection_registered; then
      log "Connector is running and registered with Cloudflare (restarts=$restart_count)."
      docker ps --filter "name=$TUNNEL_CONTAINER"
      return 0
    fi
    log "Connector process is running, but no Cloudflare edge connection is registered yet (restarts=$restart_count)."
    docker ps --filter "name=$TUNNEL_CONTAINER"
    return 1
  fi

  log "Connector is unhealthy (state=$state, restarting=$restarting, restarts=$restart_count)."
  docker ps -a --filter "name=$TUNNEL_CONTAINER"
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
