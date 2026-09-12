#!/usr/bin/env bash
# Shared helper for Codespaces scripts. The expensive Next.js production build
# runs on GitHub Actions; Codespaces only pulls the immutable image whose source
# label matches the checked-out Tutor tree.

MURIKAH_TUTOR_REMOTE_IMAGE="${MURIKAH_TUTOR_REMOTE_IMAGE:-ghcr.io/wmurikah/murikah-tutor}"

_murikah_ghcr_login() {
  local token="${GH_TOKEN:-${GITHUB_TOKEN:-}}"
  local username="${GITHUB_USER:-}"

  if [[ -z "$token" ]] && command -v gh >/dev/null 2>&1; then
    token="$(gh auth token 2>/dev/null || true)"
  fi
  if [[ -z "$username" ]] && command -v gh >/dev/null 2>&1; then
    username="$(gh api user --jq .login 2>/dev/null || true)"
  fi
  username="${username:-wmurikah}"

  if [[ -z "$token" ]]; then
    return 1
  fi

  printf '%s' "$token" | docker login ghcr.io -u "$username" --password-stdin >/dev/null 2>&1
}

murikah_pull_prebuilt_image() {
  local local_image="$1"
  local source_revision="$2"
  local attempts="${3:-1}"
  local sleep_seconds="${4:-10}"
  local remote_ref="${MURIKAH_TUTOR_REMOTE_IMAGE}:source-${source_revision}"
  local attempt label

  # The package can be private while it is first created. Authenticate when a
  # Codespaces/GitHub CLI token is available; public packages also work without
  # this login.
  _murikah_ghcr_login || true

  for ((attempt=1; attempt<=attempts; attempt++)); do
    if docker pull "$remote_ref" >/dev/null 2>&1; then
      label="$(docker image inspect -f '{{ index .Config.Labels "com.murikah.tutor.source-revision" }}' "$remote_ref" 2>/dev/null || true)"
      if [[ "$label" != "$source_revision" ]]; then
        printf '[Murikah Tutor] Refusing prebuilt image with mismatched source label.\n' >&2
        return 2
      fi
      docker tag "$remote_ref" "$local_image"
      printf '[Murikah Tutor] Pulled prebuilt Tutor image for source %s.\n' "${source_revision:0:12}"
      return 0
    fi

    if (( attempt < attempts )); then
      if (( attempt == 1 || attempt % 6 == 0 )); then
        printf '[Murikah Tutor] Prebuilt image is not published yet; waiting for GitHub Actions...\n'
      fi
      sleep "$sleep_seconds"
    fi
  done

  return 1
}
