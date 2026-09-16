"""Ordinary-user guest workspaces and public signup; never grant admin access."""
from __future__ import annotations

from contextlib import contextmanager
from functools import wraps
import json
import re
import secrets
import sqlite3
import time
from urllib.parse import urlsplit

from fastapi import APIRouter, HTTPException, Request, Response
from pydantic import BaseModel, Field
from starlette.responses import JSONResponse

PREFIX = "guest_"
LIMIT = 7
MESSAGE = "You've used your 7 guest prompts. Sign up or sign in to continue."
router = APIRouter()


def database():
    from deeptutor.multi_user.identity import AUTH_DIR
    AUTH_DIR.mkdir(parents=True, exist_ok=True)
    db = sqlite3.connect(AUTH_DIR / "murikah_guests.sqlite3", timeout=15)
    db.execute("CREATE TABLE IF NOT EXISTS guests (uid TEXT PRIMARY KEY, expires REAL NOT NULL)")
    db.execute("CREATE TABLE IF NOT EXISTS prompts (uid TEXT, request_id TEXT, PRIMARY KEY(uid, request_id))")
    return db


@contextmanager
def ledger():
    db = database()
    try:
        with db:
            yield db
    finally:
        db.close()


def reserve(uid: str, request_id: str) -> bool:
    """One atomic budget across tabs, transports and processes on this runtime."""
    with ledger() as db:
        db.execute("BEGIN IMMEDIATE")
        guest = db.execute("SELECT expires FROM guests WHERE uid=?", (uid,)).fetchone()
        if guest is None or guest[0] <= time.time():
            raise RuntimeError("Guest session expired. Sign up or sign in to continue.")
        if db.execute("SELECT 1 FROM prompts WHERE uid=? AND request_id=?", (uid, request_id)).fetchone():
            return False
        used = db.execute("SELECT COUNT(*) FROM prompts WHERE uid=?", (uid,)).fetchone()[0]
        if used >= LIMIT:
            raise RuntimeError(MESSAGE)
        db.execute("INSERT INTO prompts VALUES (?, ?)", (uid, request_id))
    return True


def release(uid: str, request_id: str):
    with ledger() as db:
        db.execute("DELETE FROM prompts WHERE uid=? AND request_id=?", (uid, request_id))


def guest_status(payload):
    if payload is None or not payload.username.startswith(PREFIX):
        return {"guest": False, "authenticated": payload is not None}
    with ledger() as db:
        row = db.execute("SELECT expires FROM guests WHERE uid=?", (payload.user_id,)).fetchone()
        used = db.execute("SELECT COUNT(*) FROM prompts WHERE uid=?", (payload.user_id,)).fetchone()[0]
    expired = not row or row[0] <= time.time()
    return {"guest": True, "used": used, "limit": LIMIT,
            "remaining": 0 if expired else max(0, LIMIT - used),
            "requires_auth": expired or used >= LIMIT}


def request_identity(request):
    from deeptutor.services.auth import decode_token
    header = request.headers.get("authorization", "")
    token = header[7:] if header.lower().startswith("bearer ") else request.cookies.get("dt_token")
    if request.scope["type"] == "websocket":
        token = request.query_params.get("token") or token
    return decode_token(token) if token else None


def check_origin(request):
    origin = request.headers.get("origin")
    if origin and urlsplit(origin).netloc != request.headers.get("host"):
        raise HTTPException(403, "Please use the Tutor website to continue.")


def set_session(response, username, uid):
    from deeptutor.services.auth import create_token
    response.set_cookie("dt_token", create_token(username, role="user", user_id=uid),
                        max_age=30 * 86400, httponly=True, secure=True, samesite="lax", path="/")
    if username.startswith(PREFIX):
        # Keep a signed guest handle when the workspace JWT expires or is logged out.
        # The server ledger, not this cookie, remains the authority for the quota.
        from jose import jwt
        from deeptutor.services.auth import AUTH_SECRET
        handle = jwt.encode({"sub": username, "uid": uid, "role": "user",
                             "exp": int(time.time()) + 30 * 86400}, AUTH_SECRET, algorithm="HS256")
        response.set_cookie("mt_guest_session", handle, max_age=30 * 86400,
                            httponly=True, secure=True, samesite="lax", path="/")
    response.headers["Cache-Control"] = "no-store"


def grant_models(uid):
    from deeptutor.multi_user.grants import empty_grant, save_grant
    from deeptutor.multi_user.model_access import admin_catalog, is_owner_bound
    grant = empty_grant(uid)
    grant["models"]["llm"] = [
        {"profile_id": p["id"], "model_ids": [m["id"] for m in p.get("models", [])]}
        for p in admin_catalog().get("services", {}).get("llm", {}).get("profiles", [])
        if not is_owner_bound(p)
    ]
    save_grant(uid, grant)


@router.get("/status")
async def access_status(request: Request, response: Response):
    response.headers["Cache-Control"] = "no-store"
    return guest_status(request_identity(request))


@router.post("/session")
async def guest_session(request: Request, response: Response):
    check_origin(request)
    payload = request_identity(request)
    if payload:
        return guest_status(payload)
    from deeptutor.services.auth import decode_token
    remembered = decode_token(request.cookies.get("mt_guest_session", ""))
    if remembered and remembered.username.startswith(PREFIX):
        set_session(response, remembered.username, remembered.user_id)
        return guest_status(remembered)
    from deeptutor.multi_user import identity
    from deeptutor.services.auth import AUTH_ENABLED, POCKETBASE_ENABLED, hash_password
    if not AUTH_ENABLED or POCKETBASE_ENABLED:
        raise HTTPException(503, "Guest access is unavailable. Please sign in.")
    username = PREFIX + secrets.token_hex(16)
    uid = identity.new_user_id()
    # No first-user promotion: guest creation bypasses save_user's bootstrap rule.
    with identity._USERS_WRITE_LOCK:
        users = identity.load_users()
        users[username] = {"id": uid, "hash": hash_password(secrets.token_urlsafe(48)),
                           "role": "user", "preset": "standard", "created_at": identity.utc_now(),
                           "disabled": False, "avatar": ""}
        identity._write_users(users)
    grant_models(uid)
    with ledger() as db:
        db.execute("INSERT INTO guests VALUES (?, ?)", (uid, time.time() + 30 * 86400))
        # Carry forward the old guest cookie's allowance; switching UI is not a reset.
        from deeptutor.api.routers.murikah_guest import _read_count
        for n in range(min(LIMIT, _read_count(request.cookies.get("mt_guest")))):
            db.execute("INSERT INTO prompts VALUES (?, ?)", (uid, f"legacy:{n}"))
    set_session(response, username, uid)
    return {"guest": True, "ok": True}


class Signup(BaseModel):
    username: str = Field(min_length=3, max_length=254)
    password: str = Field(min_length=8, max_length=72)


@router.post("/signup", status_code=201)
async def signup(body: Signup, request: Request, response: Response):
    check_origin(request)
    from deeptutor.multi_user import identity
    from deeptutor.services.auth import AUTH_ENABLED, POCKETBASE_ENABLED, hash_password
    if not AUTH_ENABLED or POCKETBASE_ENABLED:
        raise HTTPException(503, "Account creation is unavailable. Please try again later.")
    username = body.username.strip().lower()
    if (username.startswith(PREFIX) or
        not re.fullmatch(r"(?:[a-z0-9_.-]{3,64}|[^@\s]+@[^@\s]+\.[^@\s]+)", username)):
        raise HTTPException(422, "Enter a valid email address or username.")
    if len(body.password.encode()) > 72:
        raise HTTPException(422, "Password must be at most 72 UTF-8 bytes.")
    password_hash = hash_password(body.password)
    payload = request_identity(request)
    guest_name = payload.username if payload and payload.username.startswith(PREFIX) else ""
    with identity._USERS_WRITE_LOCK:
        users = identity.load_users()
        bootstrap_name, _ = identity._env_bootstrap_admin()
        if username in {name.lower() for name in users} or username == bootstrap_name.lower():
            raise HTTPException(409, "That account already exists. Please sign in.")
        record = users.get(guest_name) if guest_name else None
        if record and record.get("id") != payload.user_id:
            raise HTTPException(409, "Guest session changed. Please reload and try again.")
        record = dict(record or {"id": identity.new_user_id(), "created_at": identity.utc_now()})
        record.update(hash=password_hash, role="user", preset="standard", disabled=False)
        # Renaming keeps the workspace ID and all its conversations/files intact.
        if guest_name:
            users.pop(guest_name, None)
        users[username] = record
        identity._write_users(users)
    if guest_name:
        with ledger() as db:
            db.execute("DELETE FROM guests WHERE uid=?", (record["id"],))
    grant_models(record["id"])
    set_session(response, username, record["id"])
    return {"ok": True, "role": "user"}


def guest_prompt(method):
    """Budget accepted turns centrally, including regenerate and every capability."""
    @wraps(method)
    async def wrapped(self, *args, **kwargs):
        from deeptutor.multi_user.context import get_current_user
        from deeptutor.multi_user.identity import get_user
        user = get_current_user()
        if not user.username.startswith(PREFIX):
            return await method(self, *args, **kwargs)
        if not get_user(user.username):
            raise RuntimeError("Your account changed. Reload Tutor to continue.")
        # Count each invocation; clients cannot bypass the quota by reusing IDs.
        request_id = secrets.token_hex(16)
        charged = reserve(user.id, request_id)
        try:
            return await method(self, *args, **kwargs)
        except BaseException:
            if charged:
                release(user.id, request_id)
            raise
    return wrapped


# AI actions outside the unified turn protocol. Navigation, uploads, settings,
# saving documents and source management do not consume a prompt.
def is_http_prompt(path):
    return bool(re.search(
        r"/documents/actions/|/books(?:$|/(?:confirm-proposal|confirm-spine|compile-page|regenerate-block|insert-block|change-block-type|deep-dive|supplement|resume|rebuild)$)"
        r"|/topics/draft$|/generate-from-(?:notebook|reading)$|/extensions/[^/]+/actions/"
        r"|/notes/organize$|/memory/runs/start$|/memory/doc/[^/]+/[^/]+/(?:update|audit|dedup)$"
        r"|/connections/[^/]+/message$|/suggestions/refresh$|/api/murikah/diagram$"
        r"|/partner-groups/.+/(?:retry|summary|approve)$|/notebooks/actions/add-record-with-summary$", path))


class GuestBudgetMiddleware:
    """Budget auxiliary HTTP and WebSocket AI actions using the same ledger."""
    def __init__(self, app):
        self.app = app

    async def __call__(self, scope, receive, send):
        if scope["type"] not in {"http", "websocket"}:
            return await self.app(scope, receive, send)
        from starlette.requests import HTTPConnection
        connection = HTTPConnection(scope)
        payload = request_identity(connection)
        if not payload or not payload.username.startswith(PREFIX):
            return await self.app(scope, receive, send)
        path = scope["path"]
        # Retire the old stateless preview; it must not bypass the shared budget.
        if scope["type"] == "http" and path == "/api/murikah/guest-chat":
            return await JSONResponse({"detail": "Reload Tutor to use your guest workspace."}, 410)(scope, receive, send)
        if scope["type"] == "http":
            if scope["method"] != "POST" or not is_http_prompt(path):
                return await self.app(scope, receive, send)
            rid = secrets.token_hex(16)
            try:
                reserve(payload.user_id, rid)
            except RuntimeError as exc:
                return await JSONResponse({"detail": str(exc), "code": "guest_limit"}, 403)(scope, receive, send)
            async def counted_send(message):
                if message["type"] == "http.response.start" and message["status"] >= 400:
                    release(payload.user_id, rid)
                await send(message)
            try:
                return await self.app(scope, receive, counted_send)
            except BaseException:
                release(payload.user_id, rid)
                raise
        if not (path == "/ws/books" or path.startswith(("/ws/questions/", "/ws/partners/", "/ws/partner-groups/"))):
            return await self.app(scope, receive, send)
        async def counted_receive():
            while True:
                message = await receive()
                if message["type"] != "websocket.receive":
                    return message
                try:
                    data = json.loads(message.get("text") or "{}")
                except ValueError:
                    return message
                action = (data.get("action") or data.get("type")) if isinstance(data, dict) else None
                free_actions = {"subscribe"} if path == "/ws/books" else set()
                if path.startswith("/ws/partners/"):
                    free_actions = {"attach", "stop"}
                elif path.startswith("/ws/partner-groups/"):
                    free_actions = {"attach", "stop", "create_invocation", "reject_invocation"}
                if action in free_actions:
                    return message
                try:
                    reserve(payload.user_id, secrets.token_hex(16))
                except RuntimeError as exc:
                    await send({"type": "websocket.send", "text": json.dumps({"type": "error", "content": str(exc), "code": "guest_limit"})})
                    continue
                return message
        return await self.app(scope, counted_receive, send)
