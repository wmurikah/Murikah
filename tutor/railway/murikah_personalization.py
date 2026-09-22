"""Durable Murikah Tutor member-name personalization."""
from __future__ import annotations

import re
import unicodedata
from typing import Any

_BAD_DERIVED_NAMES = {
    "admin",
    "administrator",
    "bot",
    "contact",
    "guest",
    "info",
    "noreply",
    "no-reply",
    "root",
    "support",
    "system",
    "test",
    "unknown",
    "user",
}
_TOKEN_SPLIT = re.compile(r"[._+\-\s]+", re.UNICODE)
_MAX_PREFERRED_NAME = 64


def normalize_preferred_name(value: Any) -> str:
    """Normalize an explicit learner-selected name, or return empty to clear it."""
    text = unicodedata.normalize("NFC", str(value or "")).strip()
    if not text:
        return ""
    if any(unicodedata.category(char) in {"Cc", "Cs"} for char in text):
        raise ValueError("Preferred name contains unsupported control characters.")
    text = " ".join(text.split())
    if len(text) > _MAX_PREFERRED_NAME:
        raise ValueError(f"Preferred name must be {_MAX_PREFERRED_NAME} characters or fewer.")
    return text


def _human_token(value: Any) -> str:
    raw = unicodedata.normalize("NFC", str(value or "")).strip()
    if not raw:
        return ""
    local = raw.split("@", 1)[0]
    for part in _TOKEN_SPLIT.split(local):
        token = part.strip().strip("'\\\"~!#$%^&*()={}[]|\\\\:;,<>?/")
        if not token:
            continue
        folded = token.casefold()
        if folded in _BAD_DERIVED_NAMES:
            continue
        if any(char.isdigit() for char in token):
            continue
        if not any(char.isalpha() for char in token):
            continue
        if len(token) < 2 or len(token) > 40:
            continue
        return token[:1].upper() + token[1:].lower()
    return ""


def derive_human_name(email: Any = "", username: Any = "") -> str:
    """Derive the first sensible human token, preferring email over username."""
    return _human_token(email) or _human_token(username)


def resolve_preferred_name(
    *,
    preferred_name: Any = "",
    email: Any = "",
    username: Any = "",
) -> str:
    """Explicit preference, then email-derived name, then username-derived name."""
    explicit = normalize_preferred_name(preferred_name)
    return explicit or derive_human_name(email, username)


def personalization_for_actor(actor_id: str, username: str = "") -> dict[str, Any]:
    """Load D1-backed account personalization without exposing email to the browser."""
    fallback = derive_human_name("", username)
    try:
        from deeptutor import murikah_persistence

        row = murikah_persistence.account_personalization(actor_id)
    except Exception:
        return {
            "preferred_name": None,
            "derived_name": fallback or None,
            "needs_name_prompt": False,
        }

    preferred = normalize_preferred_name(row.get("preferred_name") or "")
    derived = derive_human_name(row.get("email") or "", row.get("username") or username)
    verified = int(row.get("email_verified_at") or 0) > 0
    decided = int(row.get("preferred_name_decided_at") or 0) > 0
    active_member = (
        str(row.get("account_status") or "") == "active"
        and str(row.get("role") or "") in {"member", "admin"}
    )
    return {
        "preferred_name": preferred or None,
        "derived_name": derived or None,
        "needs_name_prompt": bool(active_member and verified and not preferred and not decided),
    }


def update_actor_preferred_name(actor_id: str, value: Any) -> dict[str, Any]:
    """Persist an explicit preference or explicit clear in authoritative D1."""
    from deeptutor import murikah_persistence

    preferred = normalize_preferred_name(value)
    murikah_persistence.account_preferred_name_update(
        actor_id,
        preferred_name=preferred,
    )
    return personalization_for_actor(actor_id)


__all__ = [
    "derive_human_name",
    "normalize_preferred_name",
    "personalization_for_actor",
    "resolve_preferred_name",
    "update_actor_preferred_name",
]
