#!/usr/bin/env python3
"""First-boot production hardening for Murikah Tutor on Railway.

This wrapper writes only DeepTutor's own persisted runtime settings under
/app/data. It never touches Murikah's Astro, Cloudflare Worker, or Turso stack.
"""
from __future__ import annotations

import json
import os
from pathlib import Path
import tempfile

DATA_ROOT = Path("/app/data")
SETTINGS_DIR = DATA_ROOT / "user" / "settings"
AUTH_PATH = SETTINGS_DIR / "auth.json"
SYSTEM_PATH = SETTINGS_DIR / "system.json"


def atomic_write_json(path: Path, payload: dict) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    fd, tmp_name = tempfile.mkstemp(prefix=f".{path.name}.", dir=path.parent)
    try:
        with os.fdopen(fd, "w", encoding="utf-8") as handle:
            json.dump(payload, handle, indent=2, sort_keys=True)
            handle.write("\n")
        os.chmod(tmp_name, 0o600)
        os.replace(tmp_name, path)
    finally:
        if os.path.exists(tmp_name):
            os.unlink(tmp_name)


def bootstrap_auth() -> None:
    if AUTH_PATH.exists():
        current = json.loads(AUTH_PATH.read_text(encoding="utf-8"))
        if not bool(current.get("enabled")):
            raise RuntimeError(
                "Existing /app/data/user/settings/auth.json has authentication disabled. "
                "Refusing to start an Internet-facing Murikah Tutor deployment."
            )
        if not bool(current.get("cookie_secure")):
            current["cookie_secure"] = True
            atomic_write_json(AUTH_PATH, current)
            print("[Murikah Tutor] Enforced secure authentication cookie on existing settings.")
        else:
            print("[Murikah Tutor] Existing authentication settings preserved.")
        return

    username = os.environ.get("MURIKAH_TUTOR_ADMIN_USERNAME", "admin").strip() or "admin"
    password = os.environ.get("MURIKAH_TUTOR_ADMIN_PASSWORD", "")
    if len(password) < 14:
        raise RuntimeError(
            "MURIKAH_TUTOR_ADMIN_PASSWORD is required on first boot and must be at least 14 characters."
        )

    try:
        expire_hours = int(os.environ.get("MURIKAH_TUTOR_TOKEN_EXPIRE_HOURS", "24"))
    except ValueError as exc:
        raise RuntimeError("MURIKAH_TUTOR_TOKEN_EXPIRE_HOURS must be an integer.") from exc
    expire_hours = min(max(expire_hours, 1), 168)

    from deeptutor.services.auth import hash_password

    atomic_write_json(
        AUTH_PATH,
        {
            "version": 1,
            "enabled": True,
            "username": username,
            "password_hash": hash_password(password),
            "token_expire_hours": expire_hours,
            "cookie_secure": True,
        },
    )
    print(f"[Murikah Tutor] Created protected bootstrap admin: {username!r}.")


def harden_system_settings() -> None:
    if SYSTEM_PATH.exists():
        current = json.loads(SYSTEM_PATH.read_text(encoding="utf-8"))
    else:
        current = {"version": 1}

    # A public multi-user service should not execute learner-supplied subprocesses
    # inside the main application container. We can deliberately enable an isolated
    # runner in a later deployment phase.
    if os.environ.get("MURIKAH_TUTOR_ALLOW_MAIN_CONTAINER_EXEC") == "1":
        current["sandbox_allow_subprocess"] = True
        print("[Murikah Tutor] WARNING: main-container subprocess execution explicitly enabled.")
    else:
        current["sandbox_allow_subprocess"] = False

    # Railway public traffic targets the Next.js service on 3782. The FastAPI
    # backend remains internal to the same container on 8001 and is reached by
    # DeepTutor's server-side proxy.
    current["frontend_port"] = 3782
    current["backend_port"] = 8001
    current["backend_workers"] = 1

    atomic_write_json(SYSTEM_PATH, current)
    print("[Murikah Tutor] Production runtime hardening applied.")


def main() -> None:
    SETTINGS_DIR.mkdir(parents=True, exist_ok=True)
    bootstrap_auth()
    harden_system_settings()


if __name__ == "__main__":
    main()
