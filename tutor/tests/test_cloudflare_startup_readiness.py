"""Regression checks for Cloudflare Tutor startup/readiness ordering."""
from pathlib import Path
import unittest


ROOT = Path(__file__).resolve().parents[1]


def _entrypoint_text() -> str:
    source = ROOT / "cloudflare/entrypoint.sh"
    if source.exists():
        return source.read_text(encoding="utf-8")
    installed = Path("/app/murikah-cloudflare-entrypoint.sh")
    if installed.exists():
        return installed.read_text(encoding="utf-8")
    raise AssertionError("Cloudflare Tutor entrypoint is unavailable")


class CloudflareStartupReadinessTests(unittest.TestCase):
    def test_runtime_ports_start_before_reconciliation_and_checkpoint_loop(self):
        text = _entrypoint_text()
        backend = text.index("/app/start-backend.sh &")
        frontend = text.index("/app/start-frontend.sh &")
        reconcile = text.index(
            "python -m deeptutor.murikah_persistence reconcile-ownership"
        )
        sync_loop = text.index("exec python -m deeptutor.murikah_persistence sync-loop")

        self.assertLess(backend, reconcile)
        self.assertLess(frontend, reconcile)
        self.assertLess(frontend, sync_loop)
        self.assertNotIn(
            "\npython -m deeptutor.murikah_persistence sync-once\n",
            text,
        )

    def test_reconciliation_is_retrying_background_maintenance(self):
        text = _entrypoint_text()
        self.assertIn("wait_for_runtime_port()", text)
        self.assertGreaterEqual(text.count("wait_for_runtime_port"), 3)
        self.assertIn("Persistence metadata reconciliation attempt", text)
        self.assertIn("Persistence metadata reconciliation complete.", text)
        self.assertIn("reconcile_pid=$!", text)
        self.assertIn("runtime remains available", text)

    def test_source_deploy_diagnostics_refresh_after_readiness_failure(self):
        deploy = ROOT / "cloudflare/deploy_staging.py"
        if not deploy.exists():
            return
        text = deploy.read_text(encoding="utf-8")
        self.assertIn("def refreshed_failure_detail(", text)
        self.assertIn("diagnostics refresh failed:", text)
        self.assertGreaterEqual(
            text.count("refreshed_failure_detail(expected_revision)"),
            2,
        )

    def test_source_deploy_recycles_once_when_fresh_serving_instance_is_wedged(self):
        deploy = ROOT / "cloudflare/deploy_staging.py"
        if not deploy.exists():
            return
        text = deploy.read_text(encoding="utf-8")
        self.assertIn("def recover_unready_application(", text)
        self.assertIn("recycle_tutor_application()", text)
        self.assertIn("report,base=recover_unready_application(expected_revision)", text)
        self.assertIn("recycling the container application once", text)
        self.assertIn("fresh Tutor image failed isolated startup probe", text)

    def test_source_smoke_waits_for_ownership_after_runtime_health(self):
        smoke = ROOT / "cloudflare/smoke_staging.py"
        if not smoke.exists():
            return
        text = smoke.read_text(encoding="utf-8")
        self.assertIn("def wait_for_ownership_reconciliation()", text)
        self.assertIn("MURIKAH_TUTOR_OWNERSHIP_TIMEOUT", text)
        ready = text.index('if parsed.get("ready") is True:')
        ownership = text.index("wait_for_ownership_reconciliation()", ready)
        self.assertGreater(ownership, ready)


if __name__ == "__main__":
    unittest.main()
