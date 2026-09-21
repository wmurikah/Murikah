"""Murikah Tutor social sign-in overlay for Google, Microsoft and Apple.

Provider secrets come only from runtime environment variables. Successful OIDC
identities are mapped to ordinary DeepTutor users and receive the same signed
``dt_token`` session cookie as local password logins. Existing local accounts
are never auto-linked merely because an email address matches; this prevents a
social login from silently taking over an administrator account.
"""
from __future__ import annotations

import base64
from datetime import datetime, timedelta, timezone
import hashlib
import hmac
import json
import os
from pathlib import Path
import secrets
import threading
import time
from urllib.parse import urlencode

import httpx
from fastapi import APIRouter, HTTPException, Request, Response, status
from pydantic import BaseModel, Field
from fastapi.responses import RedirectResponse
from jose import JWTError, jwt

from deeptutor.api.routers.auth import _COOKIE_MAX_AGE, _cookie_attrs
from deeptutor.multi_user.identity import AUTH_DIR
from deeptutor.services.auth import AUTH_SECRET, add_user, create_token, get_user_info
from deeptutor.services.file_io import atomic_write_text

router = APIRouter()

_STATE_COOKIE = "mt_oauth_state"
_PENDING_COOKIE = "mt_oauth_pending"
_STATE_TTL_SECONDS = 10 * 60
_PENDING_TTL_SECONDS = 10 * 60
_IDENTITIES_FILE = AUTH_DIR / "murikah_social_identities.json"
_IDENTITIES_LOCK = threading.Lock()
_PUBLIC_BASE_DEFAULT = "https://tutor.murikah.com"

_PROVIDER_LABELS = {
    "google": "Google",
    "microsoft": "Microsoft",
    "apple": "Apple",
}


def _env(name: str) -> str:
    return str(os.getenv(name, "") or "").strip()


def _public_base() -> str:
    value = _env("MURIKAH_PUBLIC_BASE_URL") or _PUBLIC_BASE_DEFAULT
    return value.rstrip("/")


def _provider_config(provider: str) -> dict[str, str] | None:
    if provider == "google":
        client_id = _env("MURIKAH_GOOGLE_CLIENT_ID")
        secret = _env("MURIKAH_GOOGLE_CLIENT_SECRET")
        if not client_id or not secret:
            return None
        return {
            "client_id": client_id,
            "client_secret": secret,
            "authorize_url": "https://accounts.google.com/o/oauth2/v2/auth",
            "token_url": "https://oauth2.googleapis.com/token",
            "userinfo_url": "https://openidconnect.googleapis.com/v1/userinfo",
            "scope": "openid profile email",
        }

    if provider == "microsoft":
        client_id = _env("MURIKAH_MICROSOFT_CLIENT_ID")
        secret = _env("MURIKAH_MICROSOFT_CLIENT_SECRET")
        if not client_id or not secret:
            return None
        tenant = _env("MURIKAH_MICROSOFT_TENANT") or "common"
        authority = f"https://login.microsoftonline.com/{tenant}/oauth2/v2.0"
        return {
            "client_id": client_id,
            "client_secret": secret,
            "authorize_url": f"{authority}/authorize",
            "token_url": f"{authority}/token",
            "userinfo_url": "https://graph.microsoft.com/oidc/userinfo",
            "scope": "openid profile email",
        }

    if provider == "apple":
        client_id = _env("MURIKAH_APPLE_CLIENT_ID")
        team_id = _env("MURIKAH_APPLE_TEAM_ID")
        key_id = _env("MURIKAH_APPLE_KEY_ID")
        private_key = _apple_private_key()
        if not all((client_id, team_id, key_id, private_key)):
            return None
        return {
            "client_id": client_id,
            "team_id": team_id,
            "key_id": key_id,
            "private_key": private_key,
            "authorize_url": "https://appleid.apple.com/auth/authorize",
            "token_url": "https://appleid.apple.com/auth/token",
            "scope": "name email",
        }

    return None


def _apple_private_key() -> str:
    direct = _env("MURIKAH_APPLE_PRIVATE_KEY")
    if direct:
        return direct.replace("\\n", "\n")
    encoded = _env("MURIKAH_APPLE_PRIVATE_KEY_B64")
    if not encoded:
        return ""
    try:
        return base64.b64decode(encoded).decode("utf-8")
    except Exception:
        return ""


def _safe_next(value: str | None) -> str:
    candidate = str(value or "/chat").strip()
    if not candidate.startswith("/") or candidate.startswith("//"):
        return "/chat"
    return candidate


def _b64(data: bytes) -> str:
    return base64.urlsafe_b64encode(data).decode("ascii").rstrip("=")


def _state_secret() -> bytes:
    if not AUTH_SECRET:
        raise RuntimeError("Social sign-in requires DeepTutor authentication to be enabled")
    return AUTH_SECRET.encode("utf-8")


def _pack_state(data: dict[str, str | int]) -> str:
    raw = json.dumps(data, separators=(",", ":")).encode("utf-8")
    encoded = _b64(raw)
    signature = _b64(hmac.new(_state_secret(), encoded.encode("ascii"), hashlib.sha256).digest())
    return f"{encoded}.{signature}"


def _unpack_state(raw: str | None) -> dict[str, str | int]:
    if not raw or "." not in raw:
        raise ValueError("Missing OAuth state")
    encoded, supplied = raw.rsplit(".", 1)
    expected = _b64(hmac.new(_state_secret(), encoded.encode("ascii"), hashlib.sha256).digest())
    if not hmac.compare_digest(supplied, expected):
        raise ValueError("Invalid OAuth state signature")
    padded = encoded + "=" * (-len(encoded) % 4)
    data = json.loads(base64.urlsafe_b64decode(padded.encode("ascii")).decode("utf-8"))
    if int(data.get("exp", 0)) < int(datetime.now(timezone.utc).timestamp()):
        raise ValueError("OAuth state expired")
    return data


def _callback_url(provider: str) -> str:
    return f"{_public_base()}/api/auth/oauth/{provider}/callback"


def _pkce_pair() -> tuple[str, str]:
    verifier = secrets.token_urlsafe(64)
    challenge = _b64(hashlib.sha256(verifier.encode("ascii")).digest())
    return verifier, challenge


def _read_identities() -> dict[str, dict[str, str]]:
    try:
        loaded = json.loads(_IDENTITIES_FILE.read_text(encoding="utf-8"))
        return loaded if isinstance(loaded, dict) else {}
    except Exception:
        return {}


def _write_identities(data: dict[str, dict[str, str]]) -> None:
    _IDENTITIES_FILE.parent.mkdir(parents=True, exist_ok=True)
    atomic_write_text(_IDENTITIES_FILE, json.dumps(data, indent=2, ensure_ascii=False))


def _existing_social_username(provider: str, subject: str) -> str:
    mapping_key = f"{provider}:{subject}"
    with _IDENTITIES_LOCK:
        existing = _read_identities().get(mapping_key) or {}
    username = str(existing.get("username") or "")
    return username if username and get_user_info(username) else ""


def _social_username(provider: str, subject: str, email: str) -> str:
    mapping_key = f"{provider}:{subject}"
    with _IDENTITIES_LOCK:
        identities = _read_identities()
        existing = identities.get(mapping_key) or {}
        mapped = str(existing.get("username") or "")
        if mapped and get_user_info(mapped):
            return mapped

        normalized_email = email.strip().lower()
        # A verified provider email is pleasant as the username only when it is
        # not already owned by a local or social account. Matching alone never
        # links an existing account.
        candidate = normalized_email if normalized_email and not get_user_info(normalized_email) else ""
        if not candidate:
            short = hashlib.sha256(mapping_key.encode("utf-8")).hexdigest()[:16]
            candidate = f"{provider}-{short}@murikah.social"

        if not get_user_info(candidate):
            add_user(candidate, secrets.token_urlsafe(48), role="user", preset="standard")

        identities[mapping_key] = {
            "provider": provider,
            "subject": subject,
            "username": candidate,
            "email": normalized_email,
            "created_at": datetime.now(timezone.utc).isoformat(),
        }
        _write_identities(identities)
        return candidate


def _persist_social_account(
    username: str,
    provider: str,
    info: dict[str, object],
    *,
    email: str = "",
    email_verified_at: int = 0,
) -> None:
    if not _env("MURIKAH_TUTOR_RUNTIME").startswith("cloudflare-container"):
        return
    from deeptutor import murikah_persistence

    last_error: Exception | None = None
    for attempt in range(2):
        try:
            murikah_persistence.account_upsert(
                str(info.get("id") or ""),
                username=username,
                role="admin" if str(info.get("role") or "").lower() == "admin" else "member",
                auth_provider=provider,
                email=email,
                email_verified_at=email_verified_at,
            )
            return
        except murikah_persistence.PersistenceError as exc:
            last_error = exc
            if attempt == 0:
                time.sleep(0.2)
    raise RuntimeError("Social account storage is temporarily unavailable.") from last_error


def _session_redirect(username: str, next_path: str) -> RedirectResponse:
    info = get_user_info(username)
    if not info:
        raise RuntimeError("Social account could not be loaded")
    token = create_token(
        username,
        role=str(info.get("role") or "user"),
        user_id=str(info.get("id") or ""),
    )
    response = RedirectResponse(
        url=f"{_public_base()}{_safe_next(next_path)}",
        status_code=303,
    )
    response.set_cookie(value=token, max_age=_COOKIE_MAX_AGE, **_cookie_attrs())
    response.delete_cookie(_STATE_COOKIE, path="/api/auth/oauth")
    response.delete_cookie(_PENDING_COOKIE, path="/")
    return response


async def _login_or_verify_redirect(
    provider: str,
    subject: str,
    email: str,
    next_path: str,
    request: Request,
) -> RedirectResponse:
    existing = _existing_social_username(provider, subject)
    if existing:
        return _session_redirect(existing, next_path)

    from deeptutor.murikah_email_verification import (
        start_challenge,
        validate_signup_email,
    )

    verified_email = await validate_signup_email(email)
    challenge = start_challenge(
        verified_email,
        purpose="social_signup",
        provider=provider,
        request=request,
    )
    challenge_id = str(challenge.get("challenge_id") or "")
    if not challenge_id:
        raise RuntimeError("Email verification challenge could not be created")

    pending = _pack_state(
        {
            "provider": provider,
            "subject": subject,
            "email": verified_email,
            "challenge_id": challenge_id,
            "next": _safe_next(next_path),
            "exp": int(datetime.now(timezone.utc).timestamp()) + _PENDING_TTL_SECONDS,
        }
    )
    query = urlencode(
        {
            "verify_email": "1",
            "challenge": challenge_id,
            "provider": provider,
            "masked_email": str(challenge.get("masked_email") or ""),
            "next": _safe_next(next_path),
        }
    )
    response = RedirectResponse(
        url=f"{_public_base()}/login?{query}",
        status_code=303,
    )
    response.set_cookie(
        key=_PENDING_COOKIE,
        value=pending,
        max_age=_PENDING_TTL_SECONDS,
        httponly=True,
        secure=True,
        samesite="lax",
        path="/",
    )
    response.delete_cookie(_STATE_COOKIE, path="/api/auth/oauth")
    return response


def _error_redirect(message: str) -> RedirectResponse:
    safe = urlencode({"oauth_error": message[:160]})
    response = RedirectResponse(url=f"{_public_base()}/login?{safe}", status_code=303)
    response.delete_cookie(_STATE_COOKIE, path="/api/auth/oauth")
    response.delete_cookie(_PENDING_COOKIE, path="/")
    return response


def _apple_client_secret(config: dict[str, str]) -> str:
    now = datetime.now(timezone.utc)
    payload = {
        "iss": config["team_id"],
        "iat": int(now.timestamp()),
        "exp": int((now + timedelta(minutes=10)).timestamp()),
        "aud": "https://appleid.apple.com",
        "sub": config["client_id"],
    }
    return jwt.encode(
        payload,
        config["private_key"],
        algorithm="ES256",
        headers={"kid": config["key_id"]},
    )


async def _exchange_identity(
    provider: str,
    config: dict[str, str],
    *,
    code: str,
    verifier: str,
    nonce: str,
) -> tuple[str, str]:
    token_payload = {
        "grant_type": "authorization_code",
        "code": code,
        "redirect_uri": _callback_url(provider),
        "client_id": config["client_id"],
    }
    if provider == "apple":
        token_payload["client_secret"] = _apple_client_secret(config)
    else:
        token_payload["client_secret"] = config["client_secret"]
        token_payload["code_verifier"] = verifier

    async with httpx.AsyncClient(timeout=15.0) as client:
        token_response = await client.post(config["token_url"], data=token_payload)
        token_response.raise_for_status()
        token_data = token_response.json()

        if provider in {"google", "microsoft"}:
            access_token = str(token_data.get("access_token") or "")
            if not access_token:
                raise ValueError("Provider did not return an access token")
            user_response = await client.get(
                config["userinfo_url"],
                headers={"Authorization": f"Bearer {access_token}"},
            )
            user_response.raise_for_status()
            identity = user_response.json()
            subject = str(identity.get("sub") or "").strip()
            email = str(identity.get("email") or identity.get("preferred_username") or "").strip()
            if provider == "google" and identity.get("email_verified") is False:
                raise ValueError("Google account email is not verified")
            if not subject:
                raise ValueError("Provider identity is missing a subject identifier")
            return subject, email

        id_token = str(token_data.get("id_token") or "")
        if not id_token:
            raise ValueError("Apple did not return an identity token")
        jwks_response = await client.get("https://appleid.apple.com/auth/keys")
        jwks_response.raise_for_status()
        jwks = jwks_response.json()
        header = jwt.get_unverified_header(id_token)
        signing_key = next(
            (item for item in jwks.get("keys", []) if item.get("kid") == header.get("kid")),
            None,
        )
        if not signing_key:
            raise ValueError("Apple signing key could not be resolved")
        identity = jwt.decode(
            id_token,
            signing_key,
            algorithms=["RS256"],
            audience=config["client_id"],
            issuer="https://appleid.apple.com",
        )
        if nonce and str(identity.get("nonce") or "") != nonce:
            raise ValueError("Apple identity nonce did not match")
        subject = str(identity.get("sub") or "").strip()
        email = str(identity.get("email") or "").strip()
        if not subject:
            raise ValueError("Apple identity is missing a subject identifier")
        return subject, email


class SocialEmailVerification(BaseModel):
    challenge_id: str = Field(min_length=16, max_length=128)
    code: str = Field(min_length=6, max_length=6)


@router.post("/verify-email")
async def verify_social_email(
    body: SocialEmailVerification,
    request: Request,
    response: Response,
) -> dict:
    from deeptutor.murikah_access import check_origin
    from deeptutor.murikah_email_verification import verify_challenge

    check_origin(request)
    try:
        pending = _unpack_state(request.cookies.get(_PENDING_COOKIE))
    except ValueError as exc:
        raise HTTPException(410, "This sign-up verification has expired. Start again.") from exc

    if str(pending.get("challenge_id") or "") != body.challenge_id:
        raise HTTPException(403, "This verification code does not match this sign-up.")
    provider = str(pending.get("provider") or "")
    subject = str(pending.get("subject") or "")
    email = str(pending.get("email") or "").strip().lower()
    if provider not in _PROVIDER_LABELS or not subject or not email:
        raise HTTPException(403, "This social sign-up is incomplete. Start again.")

    verified = verify_challenge(body.challenge_id, body.code)
    if (
        str(verified.get("purpose") or "") != "social_signup"
        or str(verified.get("provider") or "") != provider
        or str(verified.get("email") or "").strip().lower() != email
    ):
        raise HTTPException(403, "This verification code does not match this sign-up.")

    username = _social_username(provider, subject, email)
    info = get_user_info(username)
    if not info:
        raise HTTPException(503, "Social account could not be created.")
    verified_at = int(verified.get("verified_at") or time.time())
    _persist_social_account(
        username,
        provider,
        info,
        email=email,
        email_verified_at=verified_at,
    )
    token = create_token(
        username,
        role=str(info.get("role") or "user"),
        user_id=str(info.get("id") or ""),
    )
    response.set_cookie(value=token, max_age=_COOKIE_MAX_AGE, **_cookie_attrs())
    response.delete_cookie(_PENDING_COOKIE, path="/")
    response.headers["Cache-Control"] = "no-store"
    return {
        "ok": True,
        "next": _safe_next(str(pending.get("next") or "/chat")),
        "email_verified": True,
    }


@router.get("/providers")
async def providers() -> dict:
    return {
        "providers": [
            {"id": provider, "label": label}
            for provider, label in _PROVIDER_LABELS.items()
            if _provider_config(provider) is not None
        ]
    }


@router.get("/{provider}/start")
async def start(provider: str, next: str = "/chat") -> RedirectResponse:  # noqa: A002
    config = _provider_config(provider)
    if provider not in _PROVIDER_LABELS:
        raise HTTPException(status_code=404, detail="Unknown social sign-in provider")
    if config is None:
        raise HTTPException(status_code=503, detail=f"{_PROVIDER_LABELS[provider]} sign-in is not configured")

    state_value = secrets.token_urlsafe(32)
    nonce = secrets.token_urlsafe(32)
    verifier, challenge = _pkce_pair()
    packed = _pack_state(
        {
            "provider": provider,
            "state": state_value,
            "nonce": nonce,
            "verifier": verifier,
            "next": _safe_next(next),
            "exp": int(datetime.now(timezone.utc).timestamp()) + _STATE_TTL_SECONDS,
        }
    )

    params = {
        "client_id": config["client_id"],
        "redirect_uri": _callback_url(provider),
        "response_type": "code",
        "scope": config["scope"],
        "state": state_value,
        "nonce": nonce,
    }
    if provider == "apple":
        params["response_mode"] = "form_post"
    else:
        params["code_challenge"] = challenge
        params["code_challenge_method"] = "S256"
        params["response_mode"] = "query"
        if provider == "google":
            params["prompt"] = "select_account"

    response = RedirectResponse(url=f"{config['authorize_url']}?{urlencode(params)}", status_code=302)
    response.set_cookie(
        key=_STATE_COOKIE,
        value=packed,
        max_age=_STATE_TTL_SECONDS,
        httponly=True,
        secure=True,
        samesite="none",
        path="/api/auth/oauth",
    )
    return response


async def _finish_callback(
    provider: str,
    request: Request,
    *,
    code: str,
    state: str,
) -> RedirectResponse:
    config = _provider_config(provider)
    if config is None:
        return _error_redirect(f"{_PROVIDER_LABELS.get(provider, provider)} sign-in is not configured")
    try:
        saved = _unpack_state(request.cookies.get(_STATE_COOKIE))
        if saved.get("provider") != provider or not hmac.compare_digest(str(saved.get("state") or ""), state):
            raise ValueError("OAuth state did not match")
        subject, email = await _exchange_identity(
            provider,
            config,
            code=code,
            verifier=str(saved.get("verifier") or ""),
            nonce=str(saved.get("nonce") or ""),
        )
        return await _login_or_verify_redirect(
            provider,
            subject,
            email,
            str(saved.get("next") or "/chat"),
            request,
        )
    except (ValueError, JWTError, httpx.HTTPError) as exc:
        return _error_redirect(str(exc) or "Social sign-in failed")
    except Exception:
        return _error_redirect("Social sign-in failed")


@router.get("/{provider}/callback")
async def callback_get(
    provider: str,
    request: Request,
    code: str = "",
    state: str = "",
    error: str = "",
) -> RedirectResponse:
    if provider == "apple":
        raise HTTPException(status_code=status.HTTP_405_METHOD_NOT_ALLOWED, detail="Apple callback requires POST")
    if provider not in {"google", "microsoft"}:
        raise HTTPException(status_code=404, detail="Unknown social sign-in provider")
    if error:
        return _error_redirect(error)
    if not code or not state:
        return _error_redirect("Provider callback was incomplete")
    return await _finish_callback(provider, request, code=code, state=state)


@router.post("/apple/callback")
async def callback_apple(request: Request) -> RedirectResponse:
    form = await request.form()
    error = str(form.get("error") or "")
    if error:
        return _error_redirect(error)
    code = str(form.get("code") or "")
    state_value = str(form.get("state") or "")
    if not code or not state_value:
        return _error_redirect("Apple callback was incomplete")
    return await _finish_callback("apple", request, code=code, state=state_value)
