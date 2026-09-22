"""Virtual Internship Phase 1 persistence/versioning regression coverage."""
from pathlib import Path
import importlib.util
import unittest

ROOT = Path(__file__).resolve().parents[1]


def source(relative: str) -> str:
    path = ROOT / relative
    return path.read_text(encoding="utf-8") if path.exists() else ""


class VirtualInternshipPhase1Tests(unittest.TestCase):
    def test_phase1_migration_shape_and_constraints(self):
        migration = source("cloudflare/migrations/0006_virtual_internship_phase1.sql")
        if not migration:
            return
        for table in (
            "scenario_packs",
            "scenario_versions",
            "internship_instances",
            "internship_memberships",
            "internship_activity",
        ):
            self.assertIn(f"CREATE TABLE IF NOT EXISTS {table}", migration)
        for marker in (
            "idx_scenario_versions_pack_status",
            "idx_internship_instances_learner_status",
            "idx_internship_instances_scenario_version",
            "idx_internship_one_active_qualifying_per_learner",
            "idx_internship_memberships_actor",
            "idx_internship_activity_internship_time",
            "UNIQUE (scenario_pack_id, version)",
            "UNIQUE (learner_id, start_request_id)",
            "CHECK (completed_at IS NULL)",
            "WHERE status = 'active' AND qualifying = 1",
        ):
            self.assertIn(marker, migration)
        self.assertNotIn("CREATE TRIGGER", migration)
        self.assertNotIn("task_graph", migration)
        self.assertNotIn("event_graph", migration)

    def test_worker_exposes_only_phase1_lifecycle_routes(self):
        worker = source("cloudflare/src/index.ts")
        if not worker:
            return
        for route in (
            "/scenario-version/resolve",
            "/internships/start",
            "/internships/status",
            "/internships/stop",
            "/internships/object-key",
        ):
            self.assertIn(route, worker)
        self.assertNotIn("/internships/complete", worker)
        self.assertIn("final_completion_available: false", worker)
        self.assertIn("pending_future_completion_gates: true", worker)

    def test_scenario_version_is_resolved_once_and_persisted(self):
        worker = source("cloudflare/src/index.ts")
        migration = source("cloudflare/migrations/0006_virtual_internship_phase1.sql")
        if not worker or not migration:
            return
        self.assertIn("resolveScenarioVersion(", worker)
        self.assertIn("scenario_version_id", migration)
        self.assertIn("FOREIGN KEY (scenario_version_id)", migration)
        self.assertIn("ORDER BY sv.version DESC LIMIT 1", worker)
        # No lifecycle route updates the pinned scenario_version_id.
        self.assertNotIn("SET scenario_version_id", worker)

    def test_adapter_methods_use_existing_persistence_bridge(self):
        path = ROOT / "railway/murikah_persistence.py"
        spec = importlib.util.spec_from_file_location("muri_vi_persistence", path)
        assert spec is not None and spec.loader is not None
        module = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(module)
        captured = []
        old_enabled, old_json, old_request = module.enabled, module._json_request, module._request
        module.enabled = lambda: True

        def fake_json(method, route, payload=None):
            captured.append((method, route, payload or {}))
            if route.endswith("/object-key"):
                return {"object_key": "users/u_123/virtual-internships/vi_1/artifacts/a_1"}
            return {"ok": True}

        def fake_request(method, route, **kwargs):
            captured.append((method, route, {}))
            return 200, b'{"ok":true,"internship":{}}', {}

        module._json_request = fake_json
        module._request = fake_request
        try:
            module.scenario_version_resolve(scenario_slug="foundation-knowledge-work")
            module.internship_start("u_123", scenario_slug="foundation-knowledge-work", request_id="req_start_1")
            module.internship_status("u_123", "vi_1")
            module.internship_stop("u_123", "vi_1", request_id="req_stop_1")
            key = module.internship_object_key(
                "u_123", "vi_1", object_type="artifacts", object_id="a_1"
            )
        finally:
            module.enabled, module._json_request, module._request = old_enabled, old_json, old_request

        self.assertEqual(key, "users/u_123/virtual-internships/vi_1/artifacts/a_1")
        routes = [item[1] for item in captured]
        self.assertIn("/__muri/persist/scenario-version/resolve", routes)
        self.assertIn("/__muri/persist/internships/start", routes)
        self.assertTrue(any("/__muri/persist/internships/status?" in route for route in routes))
        self.assertIn("/__muri/persist/internships/stop", routes)
        self.assertIn("/__muri/persist/internships/object-key", routes)
        start_payload = next(payload for method, route, payload in captured if route.endswith("/internships/start"))
        self.assertEqual(start_payload["actor_id"], "u_123")
        self.assertNotIn("learner_id", start_payload)
        self.assertNotIn("owner_id", start_payload)


if __name__ == "__main__":
    unittest.main()
