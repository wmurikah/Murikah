import unittest
from pathlib import Path

ROOT=Path(__file__).resolve().parents[1]
WORKER=(ROOT/"cloudflare/src/virtual_internship_phase9.ts").read_text()
ROUTER=(ROOT/"railway/murikah_virtual_internship.py").read_text()

class Phase9DocumentOwnershipTests(unittest.TestCase):
    def test_generation_derives_actor_from_authenticated_member(self):
        self.assertIn('Depends(require_auth)',ROUTER)
        self.assertIn('_member(current,"view internship completion documents")',ROUTER)
        self.assertIn("actor_id, username, guest = _identity(current)",ROUTER)

    def test_worker_checks_learner_ownership_for_list_and_download(self):
        self.assertIn("WHERE id=? AND learner_id=? LIMIT 1",WORKER)
        self.assertIn("d.id=? AND d.internship_id=? AND d.learner_id=?",WORKER)
        self.assertIn("String(row.owner_id) !== actorId",WORKER)

    def test_nonqualifying_active_stopped_demo_test_cannot_issue(self):
        self.assertIn("String(context.internship_status) !== 'completed'",WORKER)
        self.assertIn("String(context.mode) !== 'standard'",WORKER)
        self.assertIn("Number(context.qualifying) !== 1",WORKER)

    def test_browser_cannot_supply_completion_or_evidence_claims(self):
        for marker in ("completion_record_id","evidence_ids","strengths","development_areas","institution_name","endorsed"):
            self.assertIn("'" + marker + "'",WORKER)
        self.assertIn("invalid_document_generation_request",WORKER)

    def test_private_download_never_uses_public_r2_url(self):
        self.assertNotIn("r2.dev",WORKER)
        self.assertIn("TUTOR_FILES.get",WORKER)

if __name__=="__main__":
    unittest.main()
