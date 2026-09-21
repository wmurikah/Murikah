#!/usr/bin/env python3
"""Enforce Murikah's deployment-control boundary on the pinned Tutor runtime.

Learners may change personal learning preferences, but provider credentials,
model catalogs, model discovery/testing and other deployment configuration are
administrator-controlled. Upstream DeepTutor intentionally allows personal
Codex OAuth for ordinary users; Murikah does not expose personal model/provider
configuration, so this overlay closes that direct API path as well.

MURIKAH_ADMIN_CONTROL_POLICY_V1
"""
from __future__ import annotations

from pathlib import Path
import sys


def replace_once(path: Path, old: str, new: str, label: str) -> None:
    text = path.read_text(encoding="utf-8")
    count = text.count(old)
    if count != 1:
        raise RuntimeError(f"Expected one {label} in {path}, found {count}")
    path.write_text(text.replace(old, new, 1), encoding="utf-8")


def patch_settings_router(root: Path) -> None:
    path = root / "deeptutor/api/routers/settings.py"

    old_guard = """def _require_settings_admin() -> None:
    if not get_current_user().is_admin:
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail="Model configuration is managed by an administrator.",
        )
"""
    new_guard = """def _require_settings_admin() -> None:
    user = get_current_user()
    if not user.is_admin:
        try:
            from deeptutor import murikah_persistence
            murikah_persistence.access_audit(
                actor_id=str(user.id or ""),
                actor_role="user",
                action="change_deployment_settings",
                resource="model_provider_configuration",
                outcome="denied",
                detail="Non-admin deployment configuration request blocked.",
            )
        except Exception:
            # Audit telemetry must never turn a clean authorization denial into
            # an availability problem or leak persistence internals to learners.
            pass
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail="Model and provider configuration is managed by an administrator.",
        )
"""
    replace_once(path, old_guard, new_guard, "settings admin guard")

    old_codex = """def _require_codex_oauth_actor() -> None:
    \"\"\"Gate the Codex OAuth lifecycle: personal, not administrative.

    Every one of these endpoints acts on the *caller's own* credentials —
    ``get_codex_oauth_service()`` resolves the store, the model catalog, and
    the callback route from owner scope — so requiring an administrator was
    what left ordinary users unable to use Codex at all: an owner-bound
    profile is (correctly) never grantable, and they could not sign in for
    themselves either (#781).

    A partner is refused: it is a synthetic user whose owner is a real
    account, so letting one in would mean acting on that person's login —
    including signing them out. Partners inherit the owner's login at call
    time and need no lifecycle of their own.
    \"\"\"
    from deeptutor.services.partners.scope import is_partner_user_id

    if is_partner_user_id(get_current_user().id):
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail="A partner uses the Codex login of the account that owns it.",
        )
"""
    new_codex = """def _require_codex_oauth_actor() -> None:
    \"\"\"Murikah keeps every model/provider credential administrator-controlled.\"\"\"
    _require_settings_admin()
    from deeptutor.services.partners.scope import is_partner_user_id

    if is_partner_user_id(get_current_user().id):
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail="Partner model credentials are managed by an administrator.",
        )
"""
    replace_once(path, old_codex, new_codex, "Codex provider ownership guard")


def main() -> None:
    if len(sys.argv) != 2:
        raise SystemExit("usage: harden_admin_controls.py <deeptutor-root>")
    root = Path(sys.argv[1]).resolve()
    patch_settings_router(root)
    print(
        "[Murikah Tutor] Deployment models/providers are admin-only; "
        "learner-owned preferences remain available."
    )


if __name__ == "__main__":
    main()
