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

    def test_source_deploy_uses_live_revision_gate_without_application_recycling(self):
        deploy = ROOT / "cloudflare/deploy_staging.py"
        if not deploy.exists():
            return
        text = deploy.read_text(encoding="utf-8")
        self.assertIn("def wait_for_expected_runtime(", text)
        self.assertIn('"/__muri/runtime-status"', text)
        self.assertIn("imageRevision", text)
        self.assertIn("Deployment verified non-destructively", text)
        self.assertIn("def one_failure_diagnostic()", text)
        self.assertNotIn("recycle_tutor_application", text)
        self.assertNotIn('"containers", "delete"', text)
        self.assertNotIn("runtime image revision is still unknown after deployment", text)

    def test_successful_wrangler_deploy_is_not_replayed_for_manifest_warning(self):
        deploy = ROOT / "cloudflare/deploy_staging.py"
        if not deploy.exists():
            return
        text = deploy.read_text(encoding="utf-8")
        success = text.index("if result.returncode == 0:")
        retry = text.index("if attempt >= attempts or not is_transient_deploy_error", success)
        self.assertLess(success, retry)
        self.assertIn("exit code 0 is authoritative here", text)

    def test_health_route_reports_runtime_image_revision(self):
        health = ROOT / "railway/health-route.ts.txt"
        if not health.exists():
            return
        text = health.read_text(encoding="utf-8")
        self.assertIn('readFile("/app/murikah-cloudflare-image-rev", "utf8")', text)
        self.assertIn("imageRevision", text)
        self.assertIn("/health/ready", text)

    def test_worker_refuses_stale_container_revision(self):
        worker = ROOT / "cloudflare/src/index.ts"
        if not worker.exists():
            return
        text = worker.read_text(encoding="utf-8")
        self.assertIn("MURIKAH_EXPECTED_IMAGE_REV", text)
        self.assertIn("imageRevision === expectedRevision", text)
        self.assertIn("ready: httpReady && revisionReady", text)
        self.assertIn("Waiting for Tutor image", text)
        runtime_route = text.index("url.pathname === '/__muri/runtime-status'")
        safe_status = text.index("const status = await safeStatus(tutor, runtimeEnv);", runtime_route)
        cached_status = text.index("const status = await cachedStatus(tutor, runtimeEnv);", safe_status)
        self.assertLess(safe_status, cached_status)

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
