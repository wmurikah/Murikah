"""Regression tests for Murikah's deployment-wide member model policy."""
from pathlib import Path
from types import SimpleNamespace
import unittest


ROOT = Path(__file__).resolve().parents[1]


class SharedModelAccessTests(unittest.TestCase):
    def test_overlay_declares_dynamic_admin_model_inheritance(self):
        overlay = (ROOT / "railway/share_admin_models.py").read_text(encoding="utf-8")
        self.assertIn("def deployment_llm_rows(", overlay)
        self.assertIn("inherited = deployment_llm_rows(catalog)", overlay)
        self.assertIn("if active is None and options:", overlay)
        self.assertIn("is_owner_bound(effective)", overlay)
        self.assertIn("deployment model configuration is admin-only", overlay)

    def test_installed_runtime_exposes_shareable_models_and_excludes_owner_bound(self):
        try:
            from deeptutor.multi_user import model_access
        except Exception:
            # Source-only CI does not install the patched DeepTutor runtime.
            return

        if not hasattr(model_access, "deployment_llm_rows"):
            self.fail("installed Tutor runtime is missing deployment_llm_rows")

        catalog = {
                "services": {
                    "llm": {
                        "profiles": [
                            {
                                "id": "shared",
                                "name": "Shared",
                                "binding": "openai",
                                "models": [
                                    {"id": "m1", "name": "Model One", "model": "vendor/m1"}
                                ],
                            },
                            {
                                "id": "private",
                                "name": "Private Codex",
                                "binding": "openai_codex",
                                "models": [
                                    {"id": "m2", "name": "Private", "model": "vendor/m2"}
                                ],
                            },
                        ]
                    }
                }
            }
        rows = model_access.deployment_llm_rows(catalog)
        self.assertEqual(
            [(row["profile_id"], row["model_id"]) for row in rows],
            [("shared", "m1")],
        )
        self.assertTrue(rows[0]["available"])
        self.assertEqual(rows[0]["source"], "admin")

    def test_member_default_falls_back_to_first_shareable_model(self):
        try:
            from deeptutor.multi_user import model_access
        except Exception:
            return
        if not hasattr(model_access, "deployment_llm_rows"):
            self.fail("installed Tutor runtime is missing shared-model overlay")

        original_user = model_access.get_current_user
        original_catalog = model_access.admin_catalog
        original_redacted = model_access.redacted_model_access
        try:
            model_access.get_current_user = lambda: SimpleNamespace(
                is_admin=False, id="u_member"
            )
            model_access.admin_catalog = lambda: {
                "services": {
                    "llm": {
                        "active_profile_id": "private-admin-profile",
                        "active_model_id": "private-admin-model",
                    }
                }
            }
            model_access.redacted_model_access = lambda _user_id=None: {
                "llm": [
                    {
                        "profile_id": "shared",
                        "model_id": "m1",
                        "profile_name": "Shared",
                        "name": "Model One",
                        "model": "vendor/m1",
                        "provider": "openai",
                        "source": "admin",
                        "available": True,
                    }
                ]
            }
            result = model_access.allowed_llm_options()
            self.assertEqual(
                result["active"],
                {"profile_id": "shared", "model_id": "m1"},
            )
            self.assertEqual(len(result["options"]), 1)
        finally:
            model_access.get_current_user = original_user
            model_access.admin_catalog = original_catalog
            model_access.redacted_model_access = original_redacted


if __name__ == "__main__":
    unittest.main()
