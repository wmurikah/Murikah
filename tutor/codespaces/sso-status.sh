#!/usr/bin/env bash
set -euo pipefail

CONTAINER="murikah-tutor-codespaces"
PUBLIC_BASE="${MURIKAH_PUBLIC_BASE_URL:-https://tutor.murikah.com}"

has_outer() {
  [[ -n "${!1:-}" ]]
}

container_running=false
if docker ps --format '{{.Names}}' 2>/dev/null | grep -Fxq "$CONTAINER"; then
  container_running=true
fi

has_container() {
  local name="$1"
  [[ "$container_running" == "true" ]] || return 1
  docker exec "$CONTAINER" sh -lc "test -n \"\${${name}:-}\"" >/dev/null 2>&1
}

provider_state() {
  local provider="$1"
  shift
  local outer_ready=true
  local container_ready=true
  local name

  for name in "$@"; do
    has_outer "$name" || outer_ready=false
    has_container "$name" || container_ready=false
  done

  if [[ "$outer_ready" == "true" && "$container_ready" == "true" ]]; then
    printf '%-10s READY\n' "$provider"
  elif [[ "$outer_ready" == "true" && "$container_ready" == "false" ]]; then
    printf '%-10s RESTART NEEDED (Codespaces secrets are present, running Tutor does not have them)\n' "$provider"
  elif [[ "$outer_ready" == "false" && "$container_ready" == "true" ]]; then
    printf '%-10s RUNNING ONLY (container has credentials, current Codespace environment does not)\n' "$provider"
  else
    printf '%-10s NOT CONFIGURED\n' "$provider"
  fi
}

printf 'Murikah Tutor SSO readiness\n\n'
printf 'Public base: %s\n' "$PUBLIC_BASE"
printf 'Google callback:    %s/api/auth/oauth/google/callback\n' "$PUBLIC_BASE"
printf 'Microsoft callback: %s/api/auth/oauth/microsoft/callback\n' "$PUBLIC_BASE"
printf 'Apple callback:     %s/api/auth/oauth/apple/callback\n\n' "$PUBLIC_BASE"

provider_state "Google" \
  MURIKAH_GOOGLE_CLIENT_ID \
  MURIKAH_GOOGLE_CLIENT_SECRET

provider_state "Microsoft" \
  MURIKAH_MICROSOFT_CLIENT_ID \
  MURIKAH_MICROSOFT_CLIENT_SECRET

apple_key_ready=false
if has_outer MURIKAH_APPLE_PRIVATE_KEY || has_outer MURIKAH_APPLE_PRIVATE_KEY_B64; then
  apple_key_ready=true
fi
apple_container_key_ready=false
if has_container MURIKAH_APPLE_PRIVATE_KEY || has_container MURIKAH_APPLE_PRIVATE_KEY_B64; then
  apple_container_key_ready=true
fi

apple_outer=true
for name in MURIKAH_APPLE_CLIENT_ID MURIKAH_APPLE_TEAM_ID MURIKAH_APPLE_KEY_ID; do
  has_outer "$name" || apple_outer=false
done
[[ "$apple_key_ready" == "true" ]] || apple_outer=false

apple_container=true
for name in MURIKAH_APPLE_CLIENT_ID MURIKAH_APPLE_TEAM_ID MURIKAH_APPLE_KEY_ID; do
  has_container "$name" || apple_container=false
done
[[ "$apple_container_key_ready" == "true" ]] || apple_container=false

if [[ "$apple_outer" == "true" && "$apple_container" == "true" ]]; then
  printf '%-10s READY\n' "Apple"
elif [[ "$apple_outer" == "true" && "$apple_container" == "false" ]]; then
  printf '%-10s RESTART NEEDED (Codespaces secrets are present, running Tutor does not have them)\n' "Apple"
elif [[ "$apple_outer" == "false" && "$apple_container" == "true" ]]; then
  printf '%-10s RUNNING ONLY (container has credentials, current Codespace environment does not)\n' "Apple"
else
  printf '%-10s NOT CONFIGURED\n' "Apple"
fi

if [[ "$container_running" == "true" ]]; then
  printf '\nRuntime provider endpoint: '
  if payload="$(curl --fail --silent --show-error --max-time 5 http://127.0.0.1:3782/api/auth/oauth/providers 2>/dev/null)"; then
    python - "$payload" <<'PY'
import json
import sys
payload = json.loads(sys.argv[1])
providers = [str(item.get("label") or item.get("id")) for item in payload.get("providers", [])]
print(", ".join(providers) if providers else "no SSO providers currently exposed")
PY
  else
    printf 'unavailable\n'
  fi
else
  printf '\nTutor container is not currently running.\n'
fi

printf '\nThis command reports presence only; it never prints credential values.\n'
