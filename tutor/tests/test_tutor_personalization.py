"""Regression coverage for Murikah Tutor preferred-name personalization."""
from __future__ import annotations

import importlib.util
from pathlib import Path
import unittest

ROOT = Path(__file__).resolve().parents[1]
MODULE = ROOT / "railway" / "murikah_personalization.py"
if not MODULE.exists():
    MODULE = Path("/app/deeptutor/murikah_personalization.py")

spec = importlib.util.spec_from_file_location("muri_personalization", MODULE)
personalization = importlib.util.module_from_spec(spec)
assert spec.loader is not None
spec.loader.exec_module(personalization)


def source(relative: str) -> str:
    path = ROOT / relative
    return path.read_text(encoding="utf-8") if path.exists() else ""


class TutorPersonalizationTests(unittest.TestCase):
    def test_email_fallback_examples(self):
        cases = {
            "wilberforce@example.com": "Wilberforce",
            "wilberforce.murikah@example.com": "Wilberforce",
            "wilberforce_murikah@example.com": "Wilberforce",
            "wilberforce-murikah@example.com": "Wilberforce",
            "john.doe@example.com": "John",
            "mary_jane@example.com": "Mary",
            "peter-kimani@example.com": "Peter",
        }
        for email, expected in cases.items():
            with self.subTest(email=email):
                self.assertEqual(personalization.derive_human_name(email, ""), expected)

    def test_poor_fallbacks_are_rejected(self):
        for email in (
            "123456@example.com",
            "93747201@example.com",
            "user347293@example.com",
            "test12345@example.com",
            "noreply@example.com",
            "admin@example.com",
        ):
            with self.subTest(email=email):
                self.assertEqual(personalization.derive_human_name(email, ""), "")

    def test_preferred_name_wins_and_clear_restores_fallback(self):
        self.assertEqual(
            personalization.resolve_preferred_name(
                preferred_name="Will",
                email="wilberforce@example.com",
                username="wilberforce",
            ),
            "Will",
        )
        self.assertEqual(
            personalization.resolve_preferred_name(
                preferred_name="",
                email="wilberforce@example.com",
                username="other",
            ),
            "Wilberforce",
        )

    def test_international_names_and_validation(self):
        for name in ("Wilberforce", "W", "Dr. Kamau", "Mary Jane", "Nguyễn", "李明"):
            with self.subTest(name=name):
                self.assertEqual(personalization.normalize_preferred_name(name), name)
        self.assertEqual(
            personalization.normalize_preferred_name("  Mary   Jane  "),
            "Mary Jane",
        )
        with self.assertRaises(ValueError):
            personalization.normalize_preferred_name("Bad\nName")
        with self.assertRaises(ValueError):
            personalization.normalize_preferred_name("x" * 65)

    def test_migration_is_next_and_keeps_explicit_clear_distinct(self):
        migration = source("cloudflare/migrations/0007_tutor_preferred_name.sql")
        if not migration:
            return
        self.assertIn("ALTER TABLE tutor_accounts ADD COLUMN preferred_name TEXT", migration)
        self.assertIn("preferred_name_decided_at INTEGER", migration)
        self.assertIn("tutor_personalization_schema_version", migration)

    def test_public_api_is_actor_bound(self):
        access = source("railway/murikah_access.py")
        if not access:
            return
        self.assertIn('@router.get("/preferences")', access)
        self.assertIn('@router.put("/preferences")', access)
        self.assertIn("payload = _member_identity(request)", access)
        self.assertIn("payload.user_id", access)
        update = access[access.index('@router.put("/preferences")') :]
        self.assertNotIn("actor_id: str", update[:1200])
        self.assertNotIn("user_id: str", update[:1200])

    def test_auth_bootstrap_carries_only_resolved_personalization(self):
        overlay = source("railway/apply_tutor_personalization.py")
        if not overlay:
            return
        self.assertIn("preferred_name: str | None = None", overlay)
        self.assertIn("derived_name: str | None = None", overlay)
        self.assertIn("needs_name_prompt: bool = False", overlay)
        self.assertIn("personalization_for_actor(payload.user_id, payload.username)", overlay)
        self.assertIn("useAuthStatus", overlay)
        self.assertIn("MurikahNamePrompt", overlay)

    def test_not_now_is_session_scoped_not_permanent(self):
        ui = source("railway/MurikahPreferredName.tsx.txt")
        if not ui:
            return
        self.assertIn("window.sessionStorage.setItem", ui)
        self.assertNotIn("window.localStorage.setItem", ui)
        self.assertIn("What should I call you?", ui)
        self.assertIn("Not now", ui)
        self.assertIn("Preferred name", ui)


if __name__ == "__main__":
    unittest.main()
