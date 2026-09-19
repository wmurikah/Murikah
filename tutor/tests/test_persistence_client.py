"""Regression tests for the Cloudflare persistence client contract."""
from __future__ import annotations

import hashlib
import hmac
import importlib.util
import os
from pathlib import Path
import tempfile
import unittest

ROOT = Path(__file__).resolve().parents[1]
SOURCE = ROOT / "railway" / "murikah_persistence.py"
if not SOURCE.exists():
    SOURCE = Path("/app/deeptutor/murikah_persistence.py")

spec = importlib.util.spec_from_file_location("murikah_persistence_under_test", SOURCE)
persistence = importlib.util.module_from_spec(spec)
assert spec.loader is not None
spec.loader.exec_module(persistence)


class PersistenceClientTests(unittest.TestCase):
    def test_canonical_signature_contract(self):
        old = os.environ.get("MURIKAH_TUTOR_AUTH_SECRET")
        os.environ["MURIKAH_TUTOR_AUTH_SECRET"] = "x" * 40
        try:
            body = b'{"uid":"u_1"}'
            timestamp = "1789812000"
            nonce = "a" * 32
            content_sha = hashlib.sha256(body).hexdigest()
            canonical = persistence._canonical(
                "POST", "/__muri/persist/guest/session", timestamp, nonce, content_sha
            )
            expected = hmac.new(b"x" * 40, canonical, hashlib.sha256).hexdigest()
            self.assertEqual(len(expected), 64)
            self.assertIn(b"/__muri/persist/guest/session", canonical)
        finally:
            if old is None:
                os.environ.pop("MURIKAH_TUTOR_AUTH_SECRET", None)
            else:
                os.environ["MURIKAH_TUTOR_AUTH_SECRET"] = old

    def test_path_traversal_is_rejected(self):
        for value in ("../secret", "users/../../secret", "/../secret"):
            with self.assertRaises(persistence.PersistenceError):
                persistence._valid_relpath(value)

    def test_live_sqlite_is_exported_with_backup_api(self):
        with tempfile.TemporaryDirectory() as temp_dir:
            db_path = Path(temp_dir) / "state.sqlite3"
            import sqlite3

            db = sqlite3.connect(db_path)
            db.execute("CREATE TABLE sample (id INTEGER PRIMARY KEY, value TEXT)")
            db.execute("INSERT INTO sample(value) VALUES ('durable')")
            db.commit()
            payload = persistence._read_consistent(db_path)
            db.close()

            copy_path = Path(temp_dir) / "copy.sqlite3"
            copy_path.write_bytes(payload)
            restored = sqlite3.connect(copy_path)
            try:
                self.assertEqual(
                    restored.execute("SELECT value FROM sample").fetchone()[0], "durable"
                )
            finally:
                restored.close()

    def test_upload_uses_js_safe_millisecond_timestamp(self):
        captured = {}
        original = persistence._request

        def fake_request(method, path, **kwargs):
            captured.update(kwargs)
            return 200, b"", {}

        persistence._request = fake_request
        try:
            persistence._upload(
                "users/u1/state.json",
                b"{}",
                mtime_ns=1_789_817_400_123_456_789,
                generation="a" * 32,
            )
        finally:
            persistence._request = original

        headers = captured["extra_headers"]
        self.assertEqual(headers["x-murikah-object-mtime-ms"], "1789817400123")
        self.assertNotIn("x-murikah-object-mtime-ns", headers)

    def test_provider_catalog_and_auth_secret_are_not_checkpointed(self):
        self.assertTrue(persistence._skip("system/auth/auth_secret"))
        self.assertTrue(persistence._skip("user/settings/model_catalog.json"))
        self.assertFalse(persistence._skip("system/auth/users.json"))


if __name__ == "__main__":
    unittest.main()
