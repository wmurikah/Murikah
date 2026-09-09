#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
TUTOR_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
MURIKAH_ROOT="$(cd "$TUTOR_ROOT/.." && pwd)"
TARGET="$TUTOR_ROOT/.vendor/DeepTutor"
LOCK_FILE="$TUTOR_ROOT/source/upstream.env"
BRAND_LOGO="$MURIKAH_ROOT/docs/images/murikah_6.png"

# shellcheck disable=SC1090
source "$LOCK_FILE"

if [[ ! -f "$BRAND_LOGO" ]]; then
  echo "Murikah logo not found: $BRAND_LOGO" >&2
  exit 1
fi

rm -rf "$TARGET"
mkdir -p "$TARGET"

git -C "$TARGET" init -q
git -C "$TARGET" remote add origin "$DEEPTUTOR_REPOSITORY"
git -C "$TARGET" fetch -q --depth=1 origin "$DEEPTUTOR_COMMIT"
git -C "$TARGET" checkout -q --detach FETCH_HEAD

actual_commit="$(git -C "$TARGET" rev-parse HEAD)"
if [[ "$actual_commit" != "$DEEPTUTOR_COMMIT" ]]; then
  echo "Pinned source verification failed: expected $DEEPTUTOR_COMMIT, got $actual_commit" >&2
  exit 1
fi

cp "$BRAND_LOGO" "$TARGET/web/public/murikah-logo.png"
python3 "$SCRIPT_DIR/apply_branding.py" "$TARGET"

cat <<EOF
Murikah Tutor source materialized successfully.
Upstream: $DEEPTUTOR_REPOSITORY
Version:  $DEEPTUTOR_VERSION
Commit:   $DEEPTUTOR_COMMIT
Checkout: $TARGET

The checkout is generated and intentionally untracked. Existing Murikah application code was not modified.
EOF
