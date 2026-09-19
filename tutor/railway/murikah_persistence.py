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
import os
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
    _request(
        "PUT",
        _object_path(rel),
        body=data,
        content_type="application/octet-stream",
        extra_headers={
            "x-murikah-object-sha256": sha,
            "x-murikah-object-mtime-ns": str(max(0, int(mtime_ns))),
            "x-murikah-object-generation": generation,
            "x-murikah-object-size": str(len(data)),
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
    parser.add_argument("command", choices=("restore", "sync-once", "sync-loop", "status"))
    args = parser.parse_args()
    if args.command == "restore":
        restore()
    elif args.command == "sync-once":
        sync_once()
    elif args.command == "sync-loop":
        sync_loop()
    else:
        print(json.dumps({"enabled": enabled(), "manifest_items": len(_manifest()) if enabled() else 0}))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
