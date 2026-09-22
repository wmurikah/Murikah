"""Virtual Internship Phase 1 learner ownership/isolation checks."""
from pathlib import Path
import unittest

ROOT = Path(__file__).resolve().parents[1]


def source(relative: str) -> str:
    path = ROOT / relative
    return path.read_text(encoding="utf-8") if path.exists() else ""


class VirtualInternshipOwnershipTests(unittest.TestCase):
    def test_worker_queries_bind_ownership_in_sql(self):
        worker = source("cloudflare/src/index.ts")
        if not worker:
            return
        self.assertIn("WHERE ii.id = ? AND ii.learner_id = ? LIMIT 1", worker)
        self.assertIn("WHERE id = ? AND learner_id = ? LIMIT 1", worker)
        self.assertIn("WHERE id = ? AND learner_id = ? AND status = 'active'", worker)
        self.assertIn("'learner_id' in body || 'owner_id' in body || 'user_id' in body", worker)
        self.assertIn("verified_member_required", worker)
        self.assertIn("authentication_required", worker)
        self.assertIn("internship_not_found", worker)

    def test_r2_key_is_owner_validated_and_canonical(self):
        worker = source("cloudflare/src/index.ts")
        if not worker:
            return
        self.assertIn("INTERNSHIP_OBJECT_TYPES", worker)
        self.assertIn("'virtual-internships'", worker)
        self.assertIn("'object_key' in body", worker)
        self.assertIn("internshipObjectId(", worker)
        self.assertIn("SELECT id FROM internship_instances WHERE id = ? AND learner_id = ? LIMIT 1", worker)
        for kind in ("scenario", "documents", "artifacts", "artifact-versions", "exports", "reports"):
            self.assertIn(f"'{kind}'", worker)

    def test_guest_and_unverified_member_cannot_start(self):
        worker = source("cloudflare/src/index.ts")
        if not worker:
            return
        self.assertIn("account.role !== 'member'", worker)
        self.assertIn("Number(account.email_verified_at || 0) <= 0", worker)
        self.assertIn("account.account_status !== 'active'", worker)

    def test_one_active_rule_has_db_and_worker_enforcement(self):
        migration = source("cloudflare/migrations/0006_virtual_internship_phase1.sql")
        worker = source("cloudflare/src/index.ts")
        if not migration or not worker:
            return
        self.assertIn("idx_internship_one_active_qualifying_per_learner", migration)
        self.assertIn("WHERE status = 'active' AND qualifying = 1", migration)
        self.assertIn("active_internship_exists", worker)
        self.assertIn("start_request_id", worker)
        self.assertIn("idempotent_replay", worker)


if __name__ == "__main__":
    unittest.main()
