#!/usr/bin/env python3
"""Fail-closed checks for Murikah Tutor guest/social access overlays."""
from __future__ import annotations

from pathlib import Path
import sys

ROOT = Path(__file__).resolve().parents[2]
failures: list[str] = []


def require(relative: str) -> str:
    path = ROOT / relative
    if not path.is_file():
        failures.append(f"missing required file: {relative}")
        return ""
    return path.read_text(encoding="utf-8")


def contains(relative: str, *tokens: str) -> None:
    content = require(relative)
    for token in tokens:
        if content and token not in content:
            failures.append(f"{relative} missing invariant: {token!r}")


def main() -> int:
    contains(
        "tutor/railway/murikah_guest.py",
        "MURIKAH_GUEST_PROMPT_LIMIT",
        "_DEFAULT_LIMIT = 7",
        "min(7",
        "_MODE_GUIDANCE",
        "_SPACE_GUIDANCE",
        "/guest-chat",
        "httponly=True",
        "secure=True",
        "get_llm_client",
    )
    contains(
        "tutor/railway/murikah_oauth.py",
        "MURIKAH_GOOGLE_CLIENT_ID",
        "MURIKAH_GOOGLE_CLIENT_SECRET",
        "MURIKAH_MICROSOFT_CLIENT_ID",
        "MURIKAH_MICROSOFT_CLIENT_SECRET",
        "MURIKAH_APPLE_CLIENT_ID",
        "MURIKAH_APPLE_TEAM_ID",
        "MURIKAH_APPLE_KEY_ID",
        "MURIKAH_APPLE_PRIVATE_KEY",
        "accounts.google.com/o/oauth2/v2/auth",
        "login.microsoftonline.com",
        "appleid.apple.com/auth/authorize",
        "code_challenge_method",
        "murikah_social_identities.json",
        "create_token",
    )
    contains(
        "tutor/railway/MurikahGuestChat.tsx.txt",
        "/api/murikah/guest-chat",
        'mode: activeMode.id',
        'space: activeSpace.id',
        "Ask Questions",
        "Immersive Watching",
        "Learning Space",
        "Knowledge Center",
        "Create an account to keep learning",
        "MurikahSocialButtons",
        "Apache-2.0",
    )
    contains(
        "tutor/railway/MurikahSocialButtons.tsx.txt",
        "google",
        "microsoft",
        "apple",
        "/api/auth/oauth/",
    )
    contains(
        "tutor/railway/apply_railway_overlay.py",
        'pathname === "/"',
        "murikah_guest_router",
        "murikah_oauth_router",
        "Apache-2.0",
        "isAdmin",
        "workspace_root.unlink()",
    )
    contains(
        "tutor/codespaces/start.sh",
        "MURIKAH_PUBLIC_BASE_URL",
        "MURIKAH_GUEST_PROMPT_LIMIT",
        "${MURIKAH_GUEST_PROMPT_LIMIT:-7}",
        "MURIKAH_GOOGLE_CLIENT_ID",
        "MURIKAH_MICROSOFT_CLIENT_ID",
        "MURIKAH_APPLE_CLIENT_ID",
    )
    contains(
        "tutor/codespaces/autostart.sh",
        "MURIKAH_PUBLIC_BASE_URL",
        "MURIKAH_GUEST_PROMPT_LIMIT",
        "${MURIKAH_GUEST_PROMPT_LIMIT:-7}",
        "MURIKAH_GOOGLE_CLIENT_ID",
        "MURIKAH_MICROSOFT_CLIENT_ID",
        "MURIKAH_APPLE_CLIENT_ID",
    )
    contains(
        "tutor/Dockerfile.railway",
        "health-route.ts.txt",
        "MurikahGuestChat.tsx.txt",
        "MurikahSocialButtons.tsx.txt",
        "murikah-entry-page.tsx.txt",
        "murikah-login-page.tsx.txt",
        "murikah-register-page.tsx.txt",
        "/opt/murikah/MurikahGuestChat.tsx",
        "/opt/murikah/MurikahSocialButtons.tsx",
        "murikah_guest.py",
        "murikah_oauth.py",
    )
    for template in (
        "tutor/railway/health-route.ts.txt",
        "tutor/railway/murikah-entry-page.tsx.txt",
        "tutor/railway/murikah-login-page.tsx.txt",
        "tutor/railway/murikah-register-page.tsx.txt",
    ):
        require(template)
    require("tutor/SOCIAL_AUTH.md")

    # Compileable Next.js overlay files must not live directly under tutor/ in
    # this Astro monorepo. They are stored as .txt and renamed only in Docker.
    for forbidden in (
        "tutor/railway/health-route.ts",
        "tutor/railway/MurikahGuestChat.tsx",
        "tutor/railway/MurikahSocialButtons.tsx",
        "tutor/railway/murikah-entry-page.tsx",
        "tutor/railway/murikah-login-page.tsx",
        "tutor/railway/murikah-register-page.tsx",
    ):
        if (ROOT / forbidden).exists():
            failures.append(f"compileable overlay template must remain renamed: {forbidden}")

    # Secret names are expected in source; literal values are not.
    for relative in (
        "tutor/railway/murikah_oauth.py",
        "tutor/codespaces/start.sh",
        "tutor/codespaces/autostart.sh",
        "tutor/SOCIAL_AUTH.md",
    ):
        content = require(relative)
        for name in (
            "MURIKAH_GOOGLE_CLIENT_SECRET",
            "MURIKAH_MICROSOFT_CLIENT_SECRET",
            "MURIKAH_APPLE_PRIVATE_KEY",
        ):
            if f'{name}="' in content or f"{name}='" in content:
                failures.append(f"{relative} appears to contain literal secret material for {name}")

    if failures:
        print("Murikah Tutor social/guest preflight: FAILED")
        for failure in failures:
            print(f" - {failure}")
        return 1

    print("Murikah Tutor social/guest preflight: PASS")
    print(" - seven-prompt guest access is bounded and non-persistent")
    print(" - public learning shell exposes mode and workspace previews without showing the allowance")
    print(" - Google, Microsoft and Apple social sign-in overlays are present")
    print(" - provider credentials remain runtime-only")
    print(" - overlay templates stay outside the root Astro TypeScript compilation")
    print(" - end-user licence chrome is separated from admin developer links")
    return 0


if __name__ == "__main__":
    sys.exit(main())
