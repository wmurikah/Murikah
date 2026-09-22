"""Cloudflare D1/R2 persistence client for the Murikah Tutor container.

The Linux container never receives Cloudflare D1 or R2 credentials. Instead it
calls a private HMAC-authenticated Worker bridge. Structured guest quota state
lives in D1; the remainder of /app/data is checkpointed as private R2 objects
with a D1 manifest. SQLite files are copied through sqlite3.backup() so the
durable object is a consistent backup, never a live database on object storage.
"""
from __future__ import annotations

import argparse
import hashlib
import hmac
import json
import mimetypes
import os
import re
from pathlib import Path, PurePosixPath
import secrets
import signal
import sqlite3
import tempfile
import time
from typing import Any
from urllib.error import HTTPError, URLError
from urllib.parse import urlencode
from urllib.request import Request, urlopen
import uuid

DATA_ROOT = Path("/app/data")
PERSIST_PREFIX = "/__muri/persist"
SQLITE_MAGIC = b"SQLite format 3\x00"
DEFAULT_INTERVAL = 30
MAX_MANIFEST_ITEMS = 20000
MAX_LEARNING_CONTENT_CHARS = 120_000
MAX_LEARNING_SUMMARY_CHARS = 800
SKIP_DIRS = {"__pycache__", ".cache", ".git", "logs", "tmp"}
SKIP_PATHS = {
    "system/auth/auth_secret",
    "system/auth/murikah_guests.sqlite3",
    "user/settings/model_catalog.json",
}


class PersistenceError(RuntimeError):
    pass


def enabled() -> bool:
    runtime = os.environ.get("MURIKAH_TUTOR_RUNTIME", "").strip()
    base = os.environ.get("MURIKAH_PUBLIC_BASE_URL", "").strip()
    secret = os.environ.get("MURIKAH_TUTOR_AUTH_SECRET", "").strip()
    return runtime.startswith("cloudflare-container") and base.startswith("https://") and len(secret) >= 32


def _secret() -> bytes:
    value = os.environ.get("MURIKAH_TUTOR_AUTH_SECRET", "").strip()
    if len(value) < 32:
        raise PersistenceError("Tutor persistence signing secret is unavailable.")
    return value.encode("utf-8")


def _base_url() -> str:
    value = os.environ.get("MURIKAH_PUBLIC_BASE_URL", "").strip().rstrip("/")
    if not value.startswith("https://"):
        raise PersistenceError("Tutor public base URL is unavailable for persistence.")
    return value


def _canonical(method: str, path: str, timestamp: str, nonce: str, content_sha256: str) -> bytes:
    return "\n".join((timestamp, nonce, method.upper(), path, content_sha256)).encode("utf-8")


def _signed_headers(method: str, path: str, body: bytes) -> dict[str, str]:
    timestamp = str(int(time.time()))
    nonce = secrets.token_hex(16)
    content_sha = hashlib.sha256(body).hexdigest()
    signature = hmac.new(
        _secret(),
        _canonical(method, path, timestamp, nonce, content_sha),
        hashlib.sha256,
    ).hexdigest()
    return {
        "x-murikah-persistence-timestamp": timestamp,
        "x-murikah-persistence-nonce": nonce,
        "x-murikah-content-sha256": content_sha,
        "x-murikah-persistence-signature": signature,
        "cache-control": "no-store",
        "user-agent": "Murikah-Tutor-Persistence/1.0",
    }


def _request(
    method: str,
    path: str,
    *,
    body: bytes = b"",
    content_type: str | None = None,
    extra_headers: dict[str, str] | None = None,
    timeout: float = 20.0,
) -> tuple[int, bytes, dict[str, str]]:
    if not enabled():
        raise PersistenceError("Tutor persistence bridge is not enabled in this runtime.")
    if not path.startswith(PERSIST_PREFIX):
        raise PersistenceError("Persistence request path is invalid.")
    headers = _signed_headers(method, path, body)
    if content_type:
        headers["content-type"] = content_type
    if extra_headers:
        headers.update(extra_headers)
    request = Request(
        _base_url() + path,
        data=body if method.upper() not in {"GET", "HEAD"} else None,
        method=method.upper(),
        headers=headers,
    )
    try:
        with urlopen(request, timeout=timeout) as response:
            payload = response.read()
            return response.status, payload, {k.lower(): v for k, v in response.headers.items()}
    except HTTPError as exc:
        detail = exc.read(2048).decode("utf-8", "replace")
        raise PersistenceError(f"Persistence bridge returned HTTP {exc.code}: {detail}") from exc
    except (URLError, TimeoutError, OSError) as exc:
        raise PersistenceError(f"Persistence bridge request failed: {type(exc).__name__}") from exc


def _json_request(method: str, path: str, payload: dict[str, Any] | None = None) -> dict[str, Any]:
    body = json.dumps(payload or {}, separators=(",", ":"), sort_keys=True).encode("utf-8")
    _, raw, _ = _request(method, path, body=body, content_type="application/json")
    if not raw:
        return {}
    parsed = json.loads(raw.decode("utf-8"))
    if not isinstance(parsed, dict):
        raise PersistenceError("Persistence bridge returned an unexpected JSON payload.")
    return parsed


def _learning_text(value: Any, limit: int = MAX_LEARNING_CONTENT_CHARS) -> str:
    text = str(value or "").replace("\x00", "")
    return text[: max(0, int(limit))]


def _learning_summary(value: Any) -> str:
    """Small extractive summary without adding another model call to chat latency."""
    text = " ".join(_learning_text(value).split())
    if not text:
        return ""
    pieces = []
    current = []
    for char in text:
        current.append(char)
        if char in ".!?":
            sentence = "".join(current).strip()
            if sentence:
                pieces.append(sentence)
            current = []
            if len(pieces) >= 2:
                break
    if current and len(pieces) < 2:
        pieces.append("".join(current).strip())
    summary = " ".join(part for part in pieces if part).strip() or text
    return summary[:MAX_LEARNING_SUMMARY_CHARS]


def _selection_fields(value: Any) -> tuple[str, str]:
    if not isinstance(value, dict):
        return "", ""
    profile = str(
        value.get("profile_id")
        or value.get("profileId")
        or value.get("profile")
        or ""
    ).strip()
    model = str(
        value.get("model_id")
        or value.get("modelId")
        or value.get("model")
        or ""
    ).strip()
    return profile[:128], model[:256]


def account_upsert(
    actor_id: str,
    *,
    username: str,
    role: str,
    auth_provider: str = "local",
    email: str = "",
    email_verified_at: int = 0,
) -> None:
    if not enabled():
        return
    _json_request(
        "POST",
        f"{PERSIST_PREFIX}/account/upsert",
        {
            "actor_id": _learning_text(actor_id, 128),
            "username": "" if role == "guest" else _learning_text(username, 254),
            "role": _learning_text(role, 16),
            "auth_provider": _learning_text(auth_provider or "local", 32),
            "email": _learning_text(email, 254),
            "email_verified_at": max(0, int(email_verified_at or 0)),
        },
    )



def account_personalization(actor_id: str) -> dict[str, Any]:
    """Read non-secret D1 account personalization for one server-authenticated actor."""
    if not enabled():
        raise PersistenceError("Account personalization is unavailable.")
    query = urlencode({"actor_id": _learning_text(actor_id, 128)})
    status, raw, _ = _request("GET", f"{PERSIST_PREFIX}/account/personalization?{query}")
    if status != 200:
        raise PersistenceError(f"account_personalization_failed:{status}")
    parsed = json.loads(raw.decode("utf-8"))
    if not isinstance(parsed, dict):
        raise PersistenceError("Account personalization response is invalid.")
    return parsed


def account_preferred_name_update(
    actor_id: str,
    *,
    preferred_name: str,
) -> dict[str, Any]:
    """Persist the current actor's explicit preferred name or explicit clear."""
    if not enabled():
        raise PersistenceError("Account personalization is unavailable.")
    return _json_request(
        "POST",
        f"{PERSIST_PREFIX}/account/preferred-name",
        {
            "actor_id": _learning_text(actor_id, 128),
            "preferred_name": _learning_text(preferred_name, 64),
        },
    )


def scenario_version_resolve(
    *,
    scenario_pack_id: str = "",
    scenario_slug: str = "",
    scenario_version_id: str = "",
) -> dict[str, Any]:
    """Resolve one published scenario version through the authenticated persistence bridge."""
    if not enabled():
        raise PersistenceError("Virtual Internship persistence is unavailable.")
    return _json_request(
        "POST",
        f"{PERSIST_PREFIX}/scenario-version/resolve",
        {
            "scenario_pack_id": _learning_text(scenario_pack_id, 128),
            "scenario_slug": _learning_text(scenario_slug, 128),
            "scenario_version_id": _learning_text(scenario_version_id, 128),
        },
    )


def internship_start(
    actor_id: str,
    *,
    scenario_pack_id: str = "",
    scenario_slug: str = "",
    scenario_version_id: str = "",
    request_id: str = "",
) -> dict[str, Any]:
    """Start a qualifying internship for a server-authenticated Tutor actor.

    actor_id must come from Tutor's authenticated server-side user context.
    Learner/owner IDs are deliberately not accepted as separate inputs.
    """
    if not enabled():
        raise PersistenceError("Virtual Internship persistence is unavailable.")
    logical_request_id = _learning_text(request_id or uuid.uuid4().hex, 128)
    return _json_request(
        "POST",
        f"{PERSIST_PREFIX}/internships/start",
        {
            "actor_id": _learning_text(actor_id, 128),
            "scenario_pack_id": _learning_text(scenario_pack_id, 128),
            "scenario_slug": _learning_text(scenario_slug, 128),
            "scenario_version_id": _learning_text(scenario_version_id, 128),
            "request_id": logical_request_id,
        },
    )


def internship_status(actor_id: str, internship_id: str) -> dict[str, Any]:
    """Return owner-bound Phase 1 status using server-authenticated actor identity."""
    if not enabled():
        raise PersistenceError("Virtual Internship persistence is unavailable.")
    query = urlencode(
        {
            "actor_id": _learning_text(actor_id, 128),
            "internship_id": _learning_text(internship_id, 128),
        }
    )
    _, raw, _ = _request("GET", f"{PERSIST_PREFIX}/internships/status?{query}")
    parsed = json.loads(raw.decode("utf-8"))
    if not isinstance(parsed, dict):
        raise PersistenceError("Virtual Internship status response is invalid.")
    return parsed


def internship_stop(
    actor_id: str,
    internship_id: str,
    *,
    request_id: str = "",
) -> dict[str, Any]:
    """Stop/withdraw an owned internship without deleting its durable history."""
    if not enabled():
        raise PersistenceError("Virtual Internship persistence is unavailable.")
    logical_request_id = _learning_text(request_id or uuid.uuid4().hex, 128)
    return _json_request(
        "POST",
        f"{PERSIST_PREFIX}/internships/stop",
        {
            "actor_id": _learning_text(actor_id, 128),
            "internship_id": _learning_text(internship_id, 128),
            "request_id": logical_request_id,
        },
    )


def internship_duration_status(actor_id: str, internship_id: str) -> dict[str, Any]:
    """Return the backend-authoritative duration fields from internship status."""
    result = internship_status(actor_id, internship_id)
    internship = result.get("internship")
    if not isinstance(internship, dict):
        return result
    return {
        "internship_id": internship.get("internship_id"),
        "minimum_duration_days": internship.get("minimum_duration_days"),
        "started_at": internship.get("started_at"),
        "target_end_at": internship.get("target_end_at"),
        "current_server_time": internship.get("current_server_time"),
        "elapsed_seconds": internship.get("elapsed_seconds"),
        "elapsed_days": internship.get("elapsed_days"),
        "duration_requirement_met": internship.get("duration_requirement_met"),
        "final_completion_available": internship.get("final_completion_available"),
        "pending_future_completion_gates": internship.get("pending_future_completion_gates"),
    }


def internship_object_key(
    actor_id: str,
    internship_id: str,
    *,
    object_type: str,
    object_id: str,
) -> str:
    """Return a canonical owner-validated R2 key; callers never supply a final key."""
    if not enabled():
        raise PersistenceError("Virtual Internship persistence is unavailable.")
    result = _json_request(
        "POST",
        f"{PERSIST_PREFIX}/internships/object-key",
        {
            "actor_id": _learning_text(actor_id, 128),
            "internship_id": _learning_text(internship_id, 128),
            "object_type": _learning_text(object_type, 32),
            "object_id": _learning_text(object_id, 128),
        },
    )
    key = str(result.get("object_key") or "")
    if not key:
        raise PersistenceError("Virtual Internship object key response is invalid.")
    return key


def email_verification_start(
    email: str,
    *,
    purpose: str,
    provider: str = "",
    requester_hash: str = "",
) -> dict[str, Any]:
    if not enabled():
        raise PersistenceError("Email verification is unavailable outside durable Tutor storage.")
    return _json_request(
        "POST",
        f"{PERSIST_PREFIX}/email/start",
        {
            "email": _learning_text(email, 254),
            "purpose": _learning_text(purpose, 32),
            "provider": _learning_text(provider, 32),
            "requester_hash": _learning_text(requester_hash, 64),
        },
    )


def email_verification_resend(
    challenge_id: str,
    *,
    requester_hash: str = "",
) -> dict[str, Any]:
    if not enabled():
        raise PersistenceError("Email verification is unavailable outside durable Tutor storage.")
    return _json_request(
        "POST",
        f"{PERSIST_PREFIX}/email/resend",
        {
            "challenge_id": _learning_text(challenge_id, 128),
            "requester_hash": _learning_text(requester_hash, 64),
        },
    )


def email_verification_verify(challenge_id: str, code: str) -> dict[str, Any]:
    if not enabled():
        raise PersistenceError("Email verification is unavailable outside durable Tutor storage.")
    return _json_request(
        "POST",
        f"{PERSIST_PREFIX}/email/verify",
        {
            "challenge_id": _learning_text(challenge_id, 128),
            "code": _learning_text(code, 12),
        },
    )


def access_audit(
    *,
    actor_id: str = "",
    actor_role: str = "",
    action: str,
    resource: str,
    outcome: str,
    detail: str = "",
) -> None:
    if not enabled():
        return
    _json_request(
        "POST",
        f"{PERSIST_PREFIX}/audit",
        {
            "actor_id": _learning_text(actor_id, 128),
            "actor_role": _learning_text(actor_role, 16),
            "action": _learning_text(action, 96),
            "resource": _learning_text(resource, 192),
            "outcome": _learning_text(outcome, 16),
            "detail": _learning_text(detail, 500),
        },
    )


def reconcile_ownership() -> int:
    if not enabled():
        return 0
    result = _json_request("POST", f"{PERSIST_PREFIX}/ownership/reconcile", {})
    count = max(0, int(result.get("registered") or 0))
    print(f"[Murikah Tutor] D1 ownership registry reconciled for {count} durable objects.")
    return count


def reconcile_accounts() -> int:
    """Mirror non-secret DeepTutor account metadata into D1 after restore."""
    if not enabled():
        return 0
    try:
        from deeptutor.multi_user import identity
        from deeptutor.services.auth import get_user_info
    except Exception as exc:
        raise PersistenceError("Tutor account metadata could not be loaded.") from exc

    rows: dict[str, dict[str, Any]] = {}
    for username, record in (identity.load_users() or {}).items():
        if isinstance(record, dict) and record.get("id"):
            rows[str(username)] = record

    try:
        bootstrap_name, _ = identity._env_bootstrap_admin()
        info = get_user_info(bootstrap_name)
        if info and info.get("id"):
            rows.setdefault(str(bootstrap_name), dict(info))
    except Exception:
        pass

    reconciled = 0
    for username, record in rows.items():
        role_value = str(record.get("role") or "user").lower()
        if username.startswith("guest_"):
            role = "guest"
        elif role_value == "admin":
            role = "admin"
        else:
            role = "member"
        account_upsert(
            str(record.get("id") or ""),
            username=username,
            role=role,
            auth_provider="local",
        )
        reconciled += 1
    print(f"[Murikah Tutor] D1 account metadata reconciled for {reconciled} accounts.")
    return reconciled


def learning_actor(
    actor_id: str,
    actor_type: str,
    *,
    username: str = "",
    guest_session_id: str = "",
) -> None:
    if not enabled():
        return
    _json_request(
        "POST",
        f"{PERSIST_PREFIX}/learning/actor",
        {
            "actor_id": _learning_text(actor_id, 128),
            "actor_type": _learning_text(actor_type, 16),
            "username": "" if actor_type == "guest" else _learning_text(username, 254),
            "guest_session_id": (
                _learning_text(guest_session_id or actor_id, 128)
                if actor_type == "guest"
                else ""
            ),
        },
    )


def learning_turn_start(
    *,
    turn_id: str,
    conversation_id: str,
    actor_id: str,
    actor_type: str,
    username: str,
    prompt: str,
    capability: str,
    language: str,
    llm_selection: Any = None,
    regenerate: bool = False,
) -> None:
    if not enabled():
        return
    profile_id, model_id = _selection_fields(llm_selection)
    _json_request(
        "POST",
        f"{PERSIST_PREFIX}/learning/turn/start",
        {
            "turn_id": _learning_text(turn_id, 128),
            "conversation_id": _learning_text(conversation_id, 128),
            "actor_id": _learning_text(actor_id, 128),
            "actor_type": _learning_text(actor_type, 16),
            "username": "" if actor_type == "guest" else _learning_text(username, 254),
            "guest_session_id": _learning_text(actor_id, 128) if actor_type == "guest" else "",
            "prompt": _learning_text(prompt),
            "prompt_summary": _learning_summary(prompt),
            "capability": _learning_text(capability or "chat", 64),
            "language": _learning_text(language, 24),
            "model_profile_id": profile_id,
            "model_id": model_id,
            "regenerate": bool(regenerate),
        },
    )


def learning_turn_finish(
    *,
    turn_id: str,
    response: str,
    status: str = "completed",
    provider: str = "",
    model_id: str = "",
    first_token_ms: int = 0,
    total_ms: int = 0,
    error_code: str = "",
    error_text: str = "",
    retryable: bool = False,
) -> None:
    if not enabled():
        return
    _json_request(
        "POST",
        f"{PERSIST_PREFIX}/learning/turn/finish",
        {
            "turn_id": _learning_text(turn_id, 128),
            "response": _learning_text(response),
            "response_summary": _learning_summary(response),
            "status": _learning_text(status, 16),
            "provider": _learning_text(provider, 128),
            "model_id": _learning_text(model_id, 256),
            "first_token_ms": max(0, int(first_token_ms or 0)),
            "total_ms": max(0, int(total_ms or 0)),
            "error_code": _learning_text(error_code, 128),
            "error_text": _learning_text(error_text, 2_000),
            "retryable": bool(retryable),
        },
    )


def learning_turn_fail(
    *,
    turn_id: str,
    error: str,
    status: str = "failed",
    error_code: str = "internal_error",
    retryable: bool = True,
    total_ms: int = 0,
) -> None:
    learning_turn_finish(
        turn_id=turn_id,
        response="",
        status=status,
        total_ms=total_ms,
        error_code=error_code,
        error_text=error,
        retryable=retryable,
    )


def guest_create(uid: str, expires: float, *, used: int = 0, prompt_limit: int = 7) -> None:
    _json_request(
        "POST",
        f"{PERSIST_PREFIX}/guest/session",
        {
            "uid": uid,
            "expires_at": int(expires),
            "used_count": max(0, int(used)),
            "prompt_limit": max(1, int(prompt_limit)),
        },
    )


def guest_status(uid: str) -> dict[str, Any]:
    query = urlencode({"uid": uid})
    _, raw, _ = _request("GET", f"{PERSIST_PREFIX}/guest/status?{query}")
    parsed = json.loads(raw.decode("utf-8"))
    if not isinstance(parsed, dict):
        raise PersistenceError("Guest status response is invalid.")
    return parsed


def guest_reserve(uid: str, request_id: str) -> bool:
    result = _json_request(
        "POST", f"{PERSIST_PREFIX}/guest/reserve", {"uid": uid, "request_id": request_id}
    )
    return bool(result.get("charged", False))


def guest_release(uid: str, request_id: str) -> None:
    _json_request(
        "POST", f"{PERSIST_PREFIX}/guest/release", {"uid": uid, "request_id": request_id}
    )


def guest_delete(uid: str) -> None:
    path = f"{PERSIST_PREFIX}/guest/session?{urlencode({'uid': uid})}"
    _request("DELETE", path)


def _valid_relpath(value: str) -> str:
    raw = value.replace("\\", "/").lstrip("/")
    path = PurePosixPath(raw)
    if not raw or path.is_absolute() or ".." in path.parts or "." in path.parts:
        raise PersistenceError("Invalid persistence path.")
    return path.as_posix()


def _object_type_for_relpath(rel: str) -> str:
    value = "/" + _valid_relpath(rel).lower() + "/"
    if "/knowledge" in value or "/kb/" in value or "/rag/" in value:
        return "knowledge"
    if "/book" in value or "/reading" in value or "/notebook" in value:
        return "learning_asset"
    if "/memory" in value:
        return "memory"
    if "/session" in value or "/chat" in value or "/conversation" in value:
        return "conversation"
    if "/upload" in value or "/attachment" in value or "/document" in value or "/files/" in value:
        return "upload"
    if (
        "/diagram" in value
        or "/visual" in value
        or "/generated" in value
        or "/output" in value
        or "/math_animator" in value
    ):
        return "generated"
    if "/settings/" in value:
        return "settings"
    if "/auth/" in value or "/grant" in value:
        return "control"
    return "workspace"


def object_ownership(rel: str) -> tuple[str, str, str, str]:
    """Return owner kind/id, object type and stable object id for a cache path."""
    normalized = _valid_relpath(rel)
    parts = PurePosixPath(normalized).parts
    if (
        len(parts) >= 2
        and parts[0] == "users"
        and re.fullmatch(r"[A-Za-z0-9_-]{3,128}", parts[1])
    ):
        owner_kind, owner_id = "user", parts[1]
    elif (
        len(parts) >= 2
        and parts[0] == "partners"
        and re.fullmatch(r"[A-Za-z0-9_-]{3,128}", parts[1])
    ):
        owner_kind, owner_id = "partner", parts[1]
    elif parts and parts[0] == "user":
        owner_kind, owner_id = "admin", "admin"
    else:
        owner_kind, owner_id = "system", "system"
    object_type = _object_type_for_relpath(normalized)
    object_id = hashlib.sha256(normalized.encode("utf-8")).hexdigest()
    return owner_kind, owner_id, object_type, object_id


def _skip(rel: str) -> bool:
    rel = _valid_relpath(rel)
    if rel in SKIP_PATHS:
        return True
    parts = PurePosixPath(rel).parts
    return any(part in SKIP_DIRS for part in parts) or any(part.startswith(".tmp") for part in parts)


def _manifest() -> dict[str, dict[str, Any]]:
    _, raw, _ = _request("GET", f"{PERSIST_PREFIX}/manifest")
    parsed = json.loads(raw.decode("utf-8"))
    if not isinstance(parsed, dict) or not isinstance(parsed.get("items"), list):
        raise PersistenceError("Persistence manifest is invalid.")
    items = parsed["items"]
    if len(items) > MAX_MANIFEST_ITEMS:
        raise PersistenceError("Persistence manifest is unexpectedly large.")
    result: dict[str, dict[str, Any]] = {}
    for item in items:
        if not isinstance(item, dict):
            continue
        path = _valid_relpath(str(item.get("path") or ""))
        result[path] = item
    return result


def _read_consistent(path: Path) -> bytes:
    with path.open("rb") as handle:
        magic = handle.read(len(SQLITE_MAGIC))
    if magic != SQLITE_MAGIC:
        return path.read_bytes()
    with tempfile.TemporaryDirectory(prefix="muri-sqlite-backup-") as temp_dir:
        target = Path(temp_dir) / "snapshot.sqlite3"
        source = sqlite3.connect(f"file:{path}?mode=ro", uri=True, timeout=10)
        destination = sqlite3.connect(target)
        try:
            source.backup(destination)
        finally:
            destination.close()
            source.close()
        return target.read_bytes()


def _object_path(rel: str) -> str:
    return f"{PERSIST_PREFIX}/object?{urlencode({'path': _valid_relpath(rel)})}"


def _upload(rel: str, data: bytes, *, mtime_ns: int, generation: str) -> None:
    sha = hashlib.sha256(data).hexdigest()
    owner_kind, owner_id, object_type, object_id = object_ownership(rel)
    guessed_type = mimetypes.guess_type(rel)[0] or "application/octet-stream"
    # JavaScript/D1 INTEGER values are transported through IEEE-754 numbers.
    # Epoch nanoseconds exceed Number.MAX_SAFE_INTEGER, so persist milliseconds.
    mtime_ms = max(0, int(mtime_ns) // 1_000_000)
    _request(
        "PUT",
        _object_path(rel),
        body=data,
        content_type="application/octet-stream",
        extra_headers={
            "x-murikah-object-sha256": sha,
            "x-murikah-object-mtime-ms": str(mtime_ms),
            "x-murikah-object-generation": generation,
            "x-murikah-object-size": str(len(data)),
            "x-murikah-object-owner-kind": owner_kind,
            "x-murikah-object-owner-id": owner_id,
            "x-murikah-object-type": object_type,
            "x-murikah-object-id": object_id,
            "x-murikah-object-content-type": guessed_type,
        },
        timeout=max(20.0, min(120.0, len(data) / (1024 * 1024) * 4.0 + 20.0)),
    )


def _download(rel: str, expected_sha: str) -> bytes:
    _, payload, headers = _request("GET", _object_path(rel), timeout=60.0)
    actual = hashlib.sha256(payload).hexdigest()
    declared = headers.get("x-murikah-object-sha256", "")
    if expected_sha and actual != expected_sha:
        raise PersistenceError(f"Checksum mismatch restoring {rel}.")
    if declared and actual != declared:
        raise PersistenceError(f"Worker checksum mismatch restoring {rel}.")
    return payload


def restore() -> int:
    if not enabled():
        return 0
    remote = _manifest()
    if not remote:
        print("[Murikah Tutor] No durable /app/data checkpoint exists yet; starting from an empty store.")
        return 0
    restored = 0
    for rel, item in sorted(remote.items()):
        if _skip(rel):
            continue
        payload = _download(rel, str(item.get("sha256") or ""))
        target = DATA_ROOT / rel
        target.parent.mkdir(parents=True, exist_ok=True)
        fd, tmp_name = tempfile.mkstemp(prefix=f".{target.name}.restore.", dir=target.parent)
        try:
            with os.fdopen(fd, "wb") as handle:
                handle.write(payload)
                handle.flush()
                os.fsync(handle.fileno())
            os.replace(tmp_name, target)
        finally:
            if os.path.exists(tmp_name):
                os.unlink(tmp_name)
        restored += 1
    print(f"[Murikah Tutor] Restored {restored} durable /app/data objects from R2.")
    return restored


def sync_once() -> int:
    if not enabled():
        return 0
    DATA_ROOT.mkdir(parents=True, exist_ok=True)
    remote = _manifest()
    generation = uuid.uuid4().hex
    current_paths: list[str] = []
    uploaded = 0
    skipped_unstable = 0

    for path in sorted(DATA_ROOT.rglob("*")):
        if not path.is_file() or path.is_symlink():
            continue
        rel = _valid_relpath(path.relative_to(DATA_ROOT).as_posix())
        if _skip(rel):
            continue
        # Mark the path as current before reading it. If a live SQLite file is
        # momentarily busy, its previous durable version is retained rather
        # than being pruned by this checkpoint.
        current_paths.append(rel)
        try:
            data = _read_consistent(path)
            stat = path.stat()
        except (OSError, sqlite3.Error) as exc:
            skipped_unstable += 1
            print(f"[Murikah Tutor] Persistence skipped unstable file {rel}: {type(exc).__name__}.")
            continue
        sha = hashlib.sha256(data).hexdigest()
        known = remote.get(rel) or {}
        if str(known.get("sha256") or "") == sha and int(known.get("size_bytes") or -1) == len(data):
            continue
        _upload(rel, data, mtime_ns=stat.st_mtime_ns, generation=generation)
        uploaded += 1

    result = _json_request(
        "POST",
        f"{PERSIST_PREFIX}/commit",
        {"generation": generation, "paths": current_paths},
    )
    pruned = int(result.get("pruned") or 0)
    print(
        f"[Murikah Tutor] Durable checkpoint complete: {uploaded} uploaded, "
        f"{pruned} pruned, {len(current_paths)} current, {skipped_unstable} deferred."
    )
    return uploaded


def sync_loop() -> None:
    if not enabled():
        return
    try:
        interval = int(
            os.environ.get("MURIKAH_PERSISTENCE_INTERVAL_SECONDS", str(DEFAULT_INTERVAL))
        )
    except ValueError:
        interval = DEFAULT_INTERVAL
    interval = min(max(interval, 10), 300)
    stopping = False

    def stop(_signum, _frame):
        nonlocal stopping
        stopping = True

    signal.signal(signal.SIGTERM, stop)
    signal.signal(signal.SIGINT, stop)

    while not stopping:
        try:
            sync_once()
        except Exception as exc:
            print(f"[Murikah Tutor] Durable checkpoint failed: {type(exc).__name__}: {exc}")
        for _ in range(interval):
            if stopping:
                break
            time.sleep(1)

    try:
        sync_once()
    except Exception as exc:
        print(f"[Murikah Tutor] Final durable checkpoint failed: {type(exc).__name__}: {exc}")


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument(
        "command",
        choices=(
            "restore",
            "sync-once",
            "sync-loop",
            "reconcile-ownership",
            "reconcile-accounts",
            "status",
        ),
    )
    args = parser.parse_args()
    if args.command == "restore":
        restore()
    elif args.command == "sync-once":
        sync_once()
    elif args.command == "sync-loop":
        sync_loop()
    elif args.command == "reconcile-ownership":
        reconcile_ownership()
    elif args.command == "reconcile-accounts":
        reconcile_accounts()
    else:
        print(json.dumps({"enabled": enabled(), "manifest_items": len(_manifest()) if enabled() else 0}))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
