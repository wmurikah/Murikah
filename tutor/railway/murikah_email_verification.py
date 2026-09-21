"""Verified-email helpers for Murikah Tutor new-account creation.

New accounts must prove possession of a non-disposable email address before a
member session is created. Verification challenges live in D1; Resend delivery
is performed by the Cloudflare Worker so the email API key never enters the
Tutor container.

MURIKAH_VERIFIED_EMAIL_V1
"""
from __future__ import annotations

from functools import lru_cache
import hashlib
import hmac
from pathlib import Path
import re
from typing import Any

import httpx
from fastapi import HTTPException, Request

_EMAIL_RE = re.compile(r"^[^@\s]{1,64}@[^@\s]{1,189}\.[^@\s]{2,63}$")
_BLOCKLIST_PATH = Path(__file__).with_name("disposable_email_domains.txt")
_DNS_ENDPOINT = "https://cloudflare-dns.com/dns-query"

# Consumer providers are accepted without a network DNS lookup. Unknown
# corporate, school and university domains are accepted when they publish MX.
_KNOWN_DOMAINS = {
    "gmail.com",
    "googlemail.com",
    "outlook.com",
    "hotmail.com",
    "live.com",
    "msn.com",
    "icloud.com",
    "me.com",
    "mac.com",
    "yahoo.com",
    "yahoo.co.uk",
    "yahoo.co.in",
    "proton.me",
    "protonmail.com",
    "fastmail.com",
    "aol.com",
    "zoho.com",
    "gmx.com",
    "gmx.net",
}
_APPLE_RELAY = "privaterelay.appleid.com"


@lru_cache(maxsize=1)
def disposable_domains() -> frozenset[str]:
    try:
        rows = {
            line.strip().lower().rstrip(".")
            for line in _BLOCKLIST_PATH.read_text(encoding="utf-8").splitlines()
            if line.strip() and not line.lstrip().startswith("#")
        }
    except OSError:
        rows = set()
    # Fail closed on the best-known temporary providers even if the vendored
    # list were accidentally absent from a development image.
    rows.update(
        {
            "mailinator.com",
            "guerrillamail.com",
            "guerrillamailblock.com",
            "sharklasers.com",
            "yopmail.com",
            "10minutemail.com",
            "temp-mail.org",
            "trashmail.com",
            "dispostable.com",
            "maildrop.cc",
        }
    )
    return frozenset(rows)


def _is_disposable(domain: str) -> bool:
    blocked = disposable_domains()
    candidate = domain
    while "." in candidate:
        if candidate in blocked:
            return True
        candidate = candidate.split(".", 1)[1]
    return domain in blocked


def normalize_email(value: str) -> str:
    email = str(value or "").strip().lower()
    if not _EMAIL_RE.fullmatch(email):
        raise HTTPException(422, "Enter a valid email address.")
    local, domain = email.rsplit("@", 1)
    if local.startswith(".") or local.endswith(".") or ".." in local:
        raise HTTPException(422, "Enter a valid email address.")
    try:
        domain = domain.encode("idna").decode("ascii").lower().rstrip(".")
    except UnicodeError as exc:
        raise HTTPException(422, "Enter a valid email address.") from exc
    return f"{local}@{domain}"


async def validate_signup_email(value: str) -> str:
    email = normalize_email(value)
    domain = email.rsplit("@", 1)[1]
    if _is_disposable(domain):
        raise HTTPException(
            422,
            "Temporary or disposable email addresses cannot be used for Murikah Tutor accounts.",
        )
    if domain in _KNOWN_DOMAINS or domain == _APPLE_RELAY:
        return email

    # Corporate, university, school, NGO and other institutional addresses are
    # welcome when the domain actually advertises mail delivery.
    try:
        async with httpx.AsyncClient(timeout=4.0, trust_env=False) as client:
            response = await client.get(
                _DNS_ENDPOINT,
                params={"name": domain, "type": "MX"},
                headers={"accept": "application/dns-json"},
            )
            response.raise_for_status()
            payload = response.json()
        answers = payload.get("Answer") if isinstance(payload, dict) else None
        if (
            payload.get("Status") == 0
            and isinstance(answers, list)
            and any(
                isinstance(answer, dict)
                and int(answer.get("type") or 0) == 15
                and str(answer.get("data") or "").strip().rstrip(".") not in {"", "0 ."}
                for answer in answers
            )
        ):
            return email
    except Exception as exc:
        raise HTTPException(
            503,
            "We couldn't verify that email domain right now. Please try again.",
        ) from exc

    raise HTTPException(
        422,
        "Use an email address that can receive mail, such as Gmail, Microsoft, Apple, or a valid school, university, or company address.",
    )


def requester_hash(request: Request) -> str:
    from deeptutor.services.auth import AUTH_SECRET

    ip = (
        request.headers.get("cf-connecting-ip")
        or request.headers.get("x-forwarded-for", "").split(",", 1)[0]
        or (request.client.host if request.client else "")
    ).strip()
    agent = request.headers.get("user-agent", "")[:300]
    material = f"{ip}\n{agent}".encode("utf-8", "replace")
    secret = str(AUTH_SECRET or "").encode("utf-8")
    return hmac.new(secret, material, hashlib.sha256).hexdigest()


def _persistence():
    from deeptutor import murikah_persistence

    if not murikah_persistence.enabled():
        raise HTTPException(503, "Email verification is temporarily unavailable.")
    return murikah_persistence


def _verification_failure(exc: Exception) -> HTTPException:
    text = str(exc)
    if "verification_rate_limited" in text or "verification_send_limit" in text:
        return HTTPException(429, "Too many verification attempts. Please try again later.")
    if "verification_resend_cooldown" in text:
        return HTTPException(429, "Please wait a moment before requesting another code.")
    if "verification_expired" in text:
        return HTTPException(410, "That verification code has expired. Start again to receive a new code.")
    if "verification_attempt_limit" in text:
        return HTTPException(429, "Too many incorrect codes. Start again to receive a new code.")
    if "invalid_verification_code" in text:
        return HTTPException(422, "That verification code is incorrect.")
    if "verification_requester_mismatch" in text:
        return HTTPException(403, "This verification request belongs to a different browser session.")
    if "verification_email_unavailable" in text:
        return HTTPException(503, "We couldn't send the verification email right now. Please try again.")
    return HTTPException(503, "Email verification is temporarily unavailable. Please try again.")


def start_challenge(
    email: str,
    *,
    purpose: str,
    request: Request,
    provider: str = "",
) -> dict[str, Any]:
    persistence = _persistence()
    try:
        return persistence.email_verification_start(
            email,
            purpose=purpose,
            provider=provider,
            requester_hash=requester_hash(request),
        )
    except persistence.PersistenceError as exc:
        raise _verification_failure(exc) from exc


def resend_challenge(challenge_id: str, *, request: Request) -> dict[str, Any]:
    persistence = _persistence()
    try:
        return persistence.email_verification_resend(
            challenge_id,
            requester_hash=requester_hash(request),
        )
    except persistence.PersistenceError as exc:
        raise _verification_failure(exc) from exc


def verify_challenge(challenge_id: str, code: str) -> dict[str, Any]:
    persistence = _persistence()
    try:
        return persistence.email_verification_verify(challenge_id, code)
    except persistence.PersistenceError as exc:
        raise _verification_failure(exc) from exc


__all__ = [
    "MURIKAH_VERIFIED_EMAIL_V1",
    "normalize_email",
    "requester_hash",
    "resend_challenge",
    "start_challenge",
    "validate_signup_email",
    "verify_challenge",
]
