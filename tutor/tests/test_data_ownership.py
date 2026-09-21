"""Regression checks for Tutor D1/R2 ownership and admin-control policy."""
from pathlib import Path
import hashlib
import importlib.util
import unittest


ROOT = Path(__file__).resolve().parents[1]


class DataOwnershipTests(unittest.TestCase):
    def test_overlay_declares_explicit_user_object_ownership(self):
        source = (ROOT / "railway/murikah_persistence.py").read_text(encoding="utf-8")
        self.assertIn("def object_ownership(", source)
        self.assertIn('"x-murikah-object-owner-kind"', source)
        self.assertIn('"x-murikah-object-owner-id"', source)
        self.assertIn('"x-murikah-object-type"', source)
        self.assertIn('"x-murikah-object-id"', source)
        self.assertIn("def reconcile_ownership(", source)
        self.assertIn("def reconcile_accounts(", source)

    def test_object_ownership_classifier_is_deterministic(self):
        path = ROOT / "railway/murikah_persistence.py"
        spec = importlib.util.spec_from_file_location("murikah_persistence_overlay", path)
        module = importlib.util.module_from_spec(spec)
        assert spec.loader is not None
        spec.loader.exec_module(module)

        owner = module.object_ownership("users/u_123/workspace/uploads/report.pdf")
        self.assertEqual(owner[:3], ("user", "u_123", "upload"))
        self.assertEqual(
            owner[3],
            hashlib.sha256(
                b"users/u_123/workspace/uploads/report.pdf"
            ).hexdigest(),
        )
        self.assertEqual(
            module.object_ownership("user/settings/interface.json")[:3],
            ("admin", "admin", "settings"),
        )
        self.assertEqual(
            module.object_ownership("system/auth/users.json")[:3],
            ("system", "system", "control"),
        )
        self.assertEqual(
            module.object_ownership("partners/p_123/workspace/memory/index.json")[:3],
            ("partner", "p_123", "memory"),
        )

    def test_d1_migration_has_owner_account_and_audit_tables(self):
        migration_path = ROOT / "cloudflare/migrations/0004_tutor_object_ownership.sql"
        # Repository preflight validates the migration source before Docker
        # build. The final Tutor image intentionally copies only runtime code
        # and tests, not Wrangler migration sources, so source-only assertions
        # should not make the installed-runtime regression suite fail.
        if not migration_path.exists():
            return
        migration = migration_path.read_text(encoding="utf-8")
        self.assertIn("CREATE TABLE IF NOT EXISTS tutor_objects", migration)
        self.assertIn("owner_kind TEXT NOT NULL", migration)
        self.assertIn("owner_id TEXT NOT NULL", migration)
        self.assertIn("runtime_path TEXT NOT NULL UNIQUE", migration)
        self.assertIn("CREATE TABLE IF NOT EXISTS tutor_accounts", migration)
        self.assertIn("CREATE TABLE IF NOT EXISTS tutor_access_audit", migration)
        self.assertIn("ownership_schema_version", migration)

    def test_admin_control_overlay_closes_personal_provider_configuration(self):
        source = (ROOT / "railway/harden_admin_controls.py").read_text(
            encoding="utf-8"
        )
        self.assertIn("MURIKAH_ADMIN_CONTROL_POLICY_V1", source)
        self.assertIn("change_deployment_settings", source)
        self.assertIn("def _require_codex_oauth_actor() -> None:", source)
        self.assertIn("_require_settings_admin()", source)
        self.assertIn("learner-owned preferences remain available", source)

    def test_installed_runtime_contains_admin_control_guard_when_available(self):
        installed = Path("/app/deeptutor/api/routers/settings.py")
        if not installed.exists():
            return
        text = installed.read_text(encoding="utf-8")
        self.assertIn("change_deployment_settings", text)
        start = text.index("def _require_codex_oauth_actor() -> None:")
        snippet = text[start : start + 500]
        self.assertIn("_require_settings_admin()", snippet)


if __name__ == "__main__":
    unittest.main()
