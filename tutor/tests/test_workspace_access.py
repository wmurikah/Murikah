"""Regression coverage for guest isolation, quota, signup and provider failover.

Run: python -m unittest discover -s tutor/tests -v
The image runs the same suite against the fully materialized overlay.
"""
import asyncio
from concurrent.futures import ThreadPoolExecutor
import importlib.util
from pathlib import Path
import sqlite3
import sys
import tempfile
import threading
import time
from types import ModuleType, SimpleNamespace
import unittest
from unittest.mock import patch

from fastapi import FastAPI, WebSocket
from fastapi.testclient import TestClient
from jose import jwt

# Load crypto backends before fixture-scoped module patching.
jwt.encode({"test": True}, "unit-test-key", algorithm="HS256")

SOURCE = Path(__file__).resolve().parents[1] / "railway" / "murikah_access.py"
if not SOURCE.exists():
    SOURCE = Path("/app/deeptutor/murikah_access.py")
spec = importlib.util.spec_from_file_location("access_under_test", SOURCE)
access = importlib.util.module_from_spec(spec)
spec.loader.exec_module(access)


class AccessTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.users = {}
        self.payload = None
        identity = ModuleType("deeptutor.multi_user.identity")
        identity.AUTH_DIR = Path(self.temp.name)
        identity._USERS_WRITE_LOCK = threading.Lock()
        identity.load_users = lambda: dict(self.users)
        identity._write_users = lambda users: (self.users.clear(), self.users.update(users))
        identity.new_user_id = lambda: "u_" + access.secrets.token_hex(16)
        identity.utc_now = lambda: "2026-09-16T00:00:00Z"
        identity._env_bootstrap_admin = lambda: ("admin@example.com", "protected")
        identity.get_user = self.users.get
        parent = ModuleType("deeptutor.multi_user")
        parent.identity = identity
        auth = ModuleType("deeptutor.services.auth")
        auth.AUTH_ENABLED = True
        auth.AUTH_SECRET = "test-secret-used-only-in-unit-tests"
        auth.POCKETBASE_ENABLED = False
        auth.hash_password = lambda password: "hashed:" + password
        auth.create_token = lambda name, **kwargs: "signed-test-token"
        auth.decode_token = lambda token: self.payload
        guest = ModuleType("deeptutor.api.routers.murikah_guest")
        guest._read_count = lambda cookie: int(cookie or 0)
        context = ModuleType("deeptutor.multi_user.context")
        context.get_current_user = lambda: self.payload
        self.challenges = {}
        email_verification = ModuleType("deeptutor.murikah_email_verification")

        async def validate_signup_email(value):
            email = str(value or "").strip().lower()
            if "@" not in email or email.startswith("@") or email.endswith("@"):
                raise access.HTTPException(422, "Enter a valid email address.")
            return email

        def start_challenge(email, *, purpose, request, provider=""):
            challenge_id = "challenge_" + access.secrets.token_hex(16)
            self.challenges[challenge_id] = {
                "email": email,
                "purpose": purpose,
                "provider": provider,
                "verified_at": int(time.time()),
            }
            return {
                "challenge_id": challenge_id,
                "masked_email": email,
                "expires_in": 600,
                "resend_after": 60,
            }

        def verify_challenge(challenge_id, code):
            row = self.challenges.get(challenge_id)
            if not row or code != "123456":
                raise access.HTTPException(422, "That verification code is incorrect.")
            return dict(row)

        def normalize_email(value):
            email = str(value or "").strip().lower()
            if "@" not in email:
                raise access.HTTPException(422, "Enter a valid email address.")
            return email

        def resend_challenge(challenge_id, *, request):
            if challenge_id not in self.challenges:
                raise access.HTTPException(410, "That verification code has expired.")
            return {"ok": True, "resend_after": 60}

        email_verification.validate_signup_email = validate_signup_email
        email_verification.start_challenge = start_challenge
        email_verification.verify_challenge = verify_challenge
        email_verification.normalize_email = normalize_email
        email_verification.resend_challenge = resend_challenge
        self.modules = patch.dict(sys.modules, {
            "deeptutor.multi_user": parent, "deeptutor.multi_user.identity": identity,
            "deeptutor.services.auth": auth, "deeptutor.api.routers.murikah_guest": guest,
            "deeptutor.multi_user.context": context,
            "deeptutor.murikah_email_verification": email_verification,
        })
        self.modules.start()
        self.grants = patch.object(access, "grant_models")
        self.grants.start()
        app = FastAPI()
        app.include_router(access.router, prefix="/api/murikah/access")
        @app.post("/api/documents/actions/edit")
        async def edit(): return {"answer": "edited"}
        @app.get("/api/documents")
        async def browse(): return []
        @app.websocket("/ws/questions/judge")
        async def judge(ws: WebSocket):
            await ws.accept()
            try:
                await ws.receive_json()
                await ws.send_json({"type": "done"})
            except Exception:
                return
        @app.websocket("/ws/books")
        async def books(ws: WebSocket):
            await ws.accept()
            while True:
                try:
                    data = await ws.receive_json()
                    await ws.send_json({"type": "received", "action": data.get("type")})
                except Exception:
                    return
        app.add_middleware(access.GuestBudgetMiddleware)
        self.client = TestClient(app, base_url="https://tutor.example")

    def tearDown(self):
        self.client.close()
        self.grants.stop()
        self.modules.stop()
        self.temp.cleanup()

    def guest(self, uid="u_guest"):
        self.payload = SimpleNamespace(username="guest_example", user_id=uid, id=uid, role="user")
        self.users[self.payload.username] = {"id": uid, "role": "user", "hash": "old-hash"}
        with access.ledger() as db:
            db.execute("INSERT INTO guests VALUES (?, ?)", (uid, time.time() + 3600))
        self.client.cookies.set("dt_token", "test")
        return uid

    def signup_start(self, email, password="strong-password", **extra):
        return self.client.post(
            "/api/murikah/access/signup",
            json={"email": email, "password": password, **extra},
        )

    def signup_verify(self, start_response, email, password="strong-password"):
        challenge_id = start_response.json()["challenge_id"]
        return self.client.post(
            "/api/murikah/access/signup/verify",
            json={
                "challenge_id": challenge_id,
                "code": "123456",
                "email": email,
                "password": password,
            },
        )

    def test_seven_then_eighth_denied(self):
        uid = self.guest()
        for n in range(7): self.assertTrue(access.reserve(uid, str(n)))
        with self.assertRaisesRegex(RuntimeError, "7 guest prompts"): access.reserve(uid, "eighth")
        self.assertEqual(access.guest_status(self.payload)["remaining"], 0)

    def test_parallel_requests_cannot_exceed_seven(self):
        uid = self.guest()
        def attempt(n):
            try: return access.reserve(uid, str(n))
            except RuntimeError: return False
        with ThreadPoolExecutor(max_workers=12) as pool:
            self.assertEqual(sum(pool.map(attempt, range(30))), 7)

    def test_users_have_separate_allowances(self):
        uid = self.guest()
        for n in range(7): access.reserve(uid, str(n))
        with access.ledger() as db:
            db.execute("INSERT INTO guests VALUES (?, ?)", ("second", time.time() + 60))
        self.assertTrue(access.reserve("second", "one"))

    def test_unknown_and_expired_guests_fail_closed(self):
        with self.assertRaises(RuntimeError): access.reserve("unknown", "one")
        uid = self.guest()
        with access.ledger() as db: db.execute("UPDATE guests SET expires=0 WHERE uid=?", (uid,))
        with self.assertRaises(RuntimeError): access.reserve(uid, "one")

    def test_signup_keeps_workspace_id_and_revokes_guest(self):
        uid = self.guest()
        start = self.signup_start("wilbur@example.com")
        self.assertEqual(start.status_code, 202, start.text)
        self.assertNotIn("wilbur@example.com", self.users)
        res = self.signup_verify(start, "wilbur@example.com")
        self.assertEqual(res.status_code, 201, res.text)
        self.assertEqual(self.users["wilbur@example.com"]["id"], uid)
        self.assertEqual(self.users["wilbur@example.com"]["role"], "user")
        self.assertNotIn("guest_example", self.users)
        with self.assertRaises(RuntimeError):
            access.reserve(uid, "after-promotion")
        cookie = res.headers["set-cookie"]
        self.assertIn("HttpOnly", cookie)
        self.assertIn("Secure", cookie)

    def test_first_public_signup_is_never_admin(self):
        start = self.signup_start("first@example.com", role="admin")
        self.assertEqual(start.status_code, 202, start.text)
        res = self.signup_verify(start, "first@example.com")
        self.assertEqual(res.status_code, 201, res.text)
        self.assertEqual(self.users["first@example.com"]["role"], "user")

    def test_duplicate_case_and_bootstrap_admin_cannot_be_overwritten(self):
        self.users["Existing@Example.com"] = {"id": "u_existing", "hash": "unchanged"}
        for email in ("existing@example.com", "ADMIN@EXAMPLE.COM"):
            res = self.signup_start(email)
            self.assertEqual(res.status_code, 409, res.text)
        self.assertEqual(self.users["Existing@Example.com"]["hash"], "unchanged")

    def test_invalid_email_and_password_are_rejected_before_account_creation(self):
        for email, password in (
            ("guest_test", "strong-password"),
            ("user@example.com", "short"),
            ("user@example.com", "🎉" * 30),
        ):
            res = self.signup_start(email, password)
            self.assertEqual(res.status_code, 422, res.text)
        self.assertFalse(self.users)

    def test_cross_origin_signup_rejected(self):
        res = self.client.post(
            "/api/murikah/access/signup",
            headers={"Origin": "https://other.example"},
            json={"email": "user@example.com", "password": "strong-password"},
        )
        self.assertEqual(res.status_code, 403)

    def test_guest_creation_is_ordinary_and_carries_old_count(self):
        self.client.cookies.set("mt_guest", "5")
        res = self.client.post("/api/murikah/access/session")
        self.assertEqual(res.status_code, 200, res.text)
        record = next(iter(self.users.values()))
        self.assertEqual(record["role"], "user")
        with access.ledger() as db:
            self.assertEqual(db.execute("SELECT COUNT(*) FROM prompts WHERE uid=?", (record["id"],)).fetchone()[0], 5)

    def test_http_actions_share_budget_with_chat(self):
        uid = self.guest()
        for n in range(6): access.reserve(uid, str(n))
        self.assertEqual(self.client.post("/api/documents/actions/edit").status_code, 200)
        self.assertEqual(self.client.post("/api/documents/actions/edit").status_code, 403)
        self.assertEqual(self.client.get("/api/documents").status_code, 200)

    def test_failed_diagram_stream_refunds_but_success_uses_one_prompt(self):
        self.guest()
        from fastapi import Request
        from fastapi.responses import StreamingResponse
        app = FastAPI()
        app.add_middleware(access.GuestBudgetMiddleware)
        @app.post("/api/murikah/diagram")
        async def diagram(request: Request):
            async def body():
                yield '{"type":"status"}\n'
                if request.headers.get("x-test-fail"):
                    request.scope["murikah_prompt_failed"] = True
                    yield '{"type":"error"}\n'
                else:
                    yield '{"type":"done"}\n'
            return StreamingResponse(body(), media_type="application/x-ndjson")
        with TestClient(app) as client:
            client.cookies.set("dt_token", "test")
            self.assertEqual(client.post("/api/murikah/diagram", headers={"x-test-fail": "yes"}).status_code, 200)
            self.assertEqual(access.guest_status(self.payload)["remaining"], 7)
            self.assertEqual(client.post("/api/murikah/diagram").status_code, 200)
            self.assertEqual(access.guest_status(self.payload)["remaining"], 6)
            for _ in range(6): client.post("/api/murikah/diagram")
            self.assertEqual(client.post("/api/murikah/diagram").status_code, 403)

    def test_failed_turn_is_refunded(self):
        uid = self.guest()
        @access.guest_prompt
        async def failed(self): raise ValueError("invalid turn")
        with self.assertRaises(ValueError): asyncio.run(failed(None))
        self.assertEqual(access.guest_status(self.payload)["remaining"], 7)

    def test_turn_and_regeneration_enforce_budget(self):
        self.guest()
        @access.guest_prompt
        async def turn(self): return "accepted"
        for _ in range(7): self.assertEqual(asyncio.run(turn(None)), "accepted")
        with self.assertRaises(RuntimeError): asyncio.run(turn(None))

    def test_signed_in_user_is_not_guest_limited(self):
        self.payload = SimpleNamespace(username="ordinary", id="u_ordinary")
        @access.guest_prompt
        async def turn(self): return "accepted"
        for _ in range(10): self.assertEqual(asyncio.run(turn(None)), "accepted")

    def test_ws_query_token_cannot_bypass_budget(self):
        uid = self.guest()
        for n in range(7): access.reserve(uid, str(n))
        self.client.cookies.clear()
        with self.client.websocket_connect("/ws/questions/judge?token=test") as ws:
            ws.send_json({"question": "Q", "user_answer": "A", "type": "ping"})
            self.assertEqual(ws.receive_json()["code"], "guest_limit")

    def test_ws_books_subscribe_is_free_but_create_uses_shared_budget(self):
        uid = self.guest()
        for n in range(6): access.reserve(uid, str(n))
        with self.client.websocket_connect("/ws/books") as ws:
            ws.send_json({"type": "subscribe"})
            self.assertEqual(ws.receive_json()["action"], "subscribe")
            ws.send_json({"type": "create"})
            self.assertEqual(ws.receive_json()["action"], "create")
            ws.send_json({"type": "create"})
            self.assertEqual(ws.receive_json()["code"], "guest_limit")

    def test_logout_does_not_reset_remembered_guest_allowance(self):
        uid = self.guest()
        for n in range(7): access.reserve(uid, str(n))
        self.client.cookies.clear()
        self.client.cookies.set("mt_guest_session", "remembered")
        res = self.client.post("/api/murikah/access/session")
        self.assertEqual(res.status_code, 200)
        self.assertTrue(res.json()["requires_auth"])
        self.assertEqual(len(self.users), 1)

    def test_navigation_and_uploads_are_free(self):
        for path in ("/api/reading/materials", "/api/documents", "/api/sessions", "/api/knowledge-bases", "/api/auth/login"):
            self.assertFalse(access.is_http_prompt(path), path)
        for path in ("/api/books", "/api/partners/p1/chat", "/api/partners/p1/chat/execute-stream", "/api/murikah/diagram", "/api/mastery-paths/topics/draft", "/api/reading/materials/a/extensions/quiz/actions/generate"):
            self.assertTrue(access.is_http_prompt(path), path)


if __name__ == "__main__": unittest.main()
