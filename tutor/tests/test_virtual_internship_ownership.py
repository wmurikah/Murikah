"""Phase 1 ownership/isolation, auth and R2-key contract tests."""
from pathlib import Path
import importlib.util
import unittest


ROOT = Path(__file__).resolve().parents[1]
WORKER = ROOT / "cloudflare/src/index.ts"
ACCESS = ROOT / "railway/murikah_access.py"
PERSISTENCE = ROOT / "railway/murikah_persistence.py"


def persistence_module():
    spec = importlib.util.spec_from_file_location("muri_phase1_persistence", PERSISTENCE)
    module = importlib.util.module_from_spec(spec)
    assert spec is not None and spec.loader is not None
    spec.loader.exec_module(module)
    return module


class VirtualInternshipOwnershipTests(unittest.TestCase):
    def test_worker_rechecks_active_verified_member_in_d1(self):
        source = WORKER.read_text(encoding="utf-8")
        block = source[source.index("async function verifiedInternshipMember"):source.index("function safeInternshipSegment")]
        self.assertIn("FROM tutor_accounts WHERE actor_id = ?", block)
        self.assertIn("account.role === 'member'", block)
        self.assertIn("account.account_status === 'active'", block)
        self.assertIn("email_verified_at", block)

    def test_status_stop_and_object_key_queries_are_actor_bound(self):
        source = WORKER.read_text(encoding="utf-8")
        self.assertIn("WHERE i.id = ? AND i.learner_id = ?", source)
        self.assertIn(
            "WHERE id = ? AND learner_id = ? AND status = 'active'",
            source,
        )
        self.assertIn(
            "SELECT id FROM internship_instances WHERE id = ? AND learner_id = ?",
            source,
        )
        self.assertIn("{ error: 'internship_not_found' }", source)

    def test_public_api_has_no_browser_owner_fields_and_forbids_extra_fields(self):
        source = ACCESS.read_text(encoding="utf-8")
        start = source[source.index("class InternshipStartRequest"):source.index("class InternshipStopRequest")]
        self.assertNotIn("learner_id", start)
        self.assertNotIn("owner_id", start)
        self.assertNotIn("user_id", start)
        self.assertIn('extra = "forbid"', start)
        self.assertIn("actor_id = str(getattr(payload, \"user_id\"", source)
        self.assertIn("startswith(PREFIX)", source)
        self.assertIn('@router.post("/internships/start")', source)
        self.assertIn('@router.get("/internships/{internship_id}/status")', source)
        self.assertIn('@router.post("/internships/{internship_id}/stop")', source)

    def test_persistence_client_forwards_server_actor_not_learner_override(self):
        module = persistence_module()
        captured = {}
        original = module._json_request
        try:
            def fake(method, path, payload=None):
                captured.update(method=method, path=path, payload=dict(payload or {}))
                return {"internship_id": "internship_123"}

            module._json_request = fake
            module.internship_start(
                "member_123",
                request_id="request_123",
                scenario_slug="phase1-foundation-internship",
            )
        finally:
            module._json_request = original

        self.assertEqual(captured["payload"]["actor_id"], "member_123")
        self.assertNotIn("learner_id", captured["payload"])
        self.assertNotIn("owner_id", captured["payload"])
        self.assertNotIn("user_id", captured["payload"])

    def test_canonical_r2_key_helper_is_owner_scoped_and_rejects_foreign_prefix(self):
        worker = WORKER.read_text(encoding="utf-8")
        helper = worker[worker.index("function internshipObjectKey"):worker.index("async function resolveScenarioVersion")]
        self.assertIn("'users'", helper)
        self.assertIn("'virtual-internships'", helper)
        self.assertIn("encodeURIComponent(actorId)", helper)
        self.assertIn("encodeURIComponent(internshipId)", helper)

        module = persistence_module()
        original = module._json_request
        try:
            module._json_request = lambda *args, **kwargs: {
                "object_key": "users/member_123/virtual-internships/internship_123/artifacts/artifact_123"
            }
            key = module.internship_object_key(
                "member_123",
                "internship_123",
                object_type="artifacts",
                object_id="artifact_123",
            )
            self.assertEqual(
                key,
                "users/member_123/virtual-internships/internship_123/artifacts/artifact_123",
            )

            module._json_request = lambda *args, **kwargs: {
                "object_key": "users/member_other/virtual-internships/internship_123/artifacts/artifact_123"
            }
            with self.assertRaises(module.PersistenceError):
                module.internship_object_key(
                    "member_123",
                    "internship_123",
                    object_type="artifacts",
                    object_id="artifact_123",
                )
        finally:
            module._json_request = original

    def test_r2_segment_policy_rejects_traversal_and_arbitrary_types(self):
        source = WORKER.read_text(encoding="utf-8")
        self.assertIn("decodeURIComponent(raw)", source)
        self.assertIn("decoded === '..'", source)
        self.assertIn("INTERNSHIP_R2_OBJECT_TYPES.has(objectType)", source)
        self.assertIn("'artifact-versions'", source)
        self.assertNotIn("body.object_key", source)

    def test_status_path_is_small_d1_query_and_does_not_read_r2_or_call_models(self):
        source = WORKER.read_text(encoding="utf-8")
        block = source[source.index("async function internshipStatusForActor"):source.index("async function handlePersistence")]
        self.assertIn("FROM internship_instances i", block)
        self.assertIn("WHERE i.id = ? AND i.learner_id = ?", block)
        self.assertNotIn("TUTOR_FILES", block)
        self.assertNotIn("fetch(", block)


if __name__ == "__main__":
    unittest.main()
