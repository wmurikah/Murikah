"""Regression tests for guest/session origin validation behind the Next.js loopback proxy."""
import importlib.util
import os
from pathlib import Path
from types import SimpleNamespace
import unittest
from unittest.mock import patch

from fastapi import HTTPException

SOURCE = Path(__file__).resolve().parents[1] / "railway" / "murikah_access.py"
if not SOURCE.exists():
    SOURCE = Path("/app/deeptutor/murikah_access.py")
spec = importlib.util.spec_from_file_location("access_origin_under_test", SOURCE)
access = importlib.util.module_from_spec(spec)
spec.loader.exec_module(access)


class ProxyOriginTests(unittest.TestCase):
    def test_public_origin_is_allowed_when_backend_host_is_loopback(self):
        request = SimpleNamespace(headers={
            "origin": "https://tutor.murikah.com",
            "host": "127.0.0.1:8001",
        })
        with patch.dict(os.environ, {"MURIKAH_PUBLIC_BASE_URL": "https://tutor.murikah.com"}, clear=False):
            access.check_origin(request)

    def test_forwarded_public_host_is_allowed(self):
        request = SimpleNamespace(headers={
            "origin": "https://tutor.murikah.com",
            "host": "127.0.0.1:8001",
            "x-forwarded-host": "tutor.murikah.com",
        })
        with patch.dict(os.environ, {"MURIKAH_PUBLIC_BASE_URL": ""}, clear=False):
            access.check_origin(request)

    def test_cross_origin_is_still_rejected(self):
        request = SimpleNamespace(headers={
            "origin": "https://other.example",
            "host": "127.0.0.1:8001",
            "x-forwarded-host": "tutor.murikah.com",
        })
        with patch.dict(os.environ, {"MURIKAH_PUBLIC_BASE_URL": "https://tutor.murikah.com"}, clear=False):
            with self.assertRaises(HTTPException) as caught:
                access.check_origin(request)
        self.assertEqual(caught.exception.status_code, 403)


if __name__ == "__main__":
    unittest.main()
