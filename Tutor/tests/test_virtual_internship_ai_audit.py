from pathlib import Path
import sys
import unittest

ROOT=Path(__file__).resolve().parents[1]
sys.path.insert(0,str(ROOT/"railway"))
sys.path.insert(0,str(ROOT/"tests"))
from virtual_internship_ai_fakes import AuditSink, FakeStateService, FakeStream, candidate
from virtual_internship.ai.orchestrator import VirtualInternshipAIOrchestrator


class AIAuditTests(unittest.IsolatedAsyncioTestCase):
    async def test_success_audit_has_traceability_without_secrets_or_reasoning(self):
        sink=AuditSink()
        orch=VirtualInternshipAIOrchestrator(
            FakeStateService(),candidate_resolver=lambda *_a,**_k:[candidate()],
            stream_factory=lambda *_a,**_k:FakeStream(["Workplace reply."]),audit_recorder=sink,
        )
        [i async for i in orch.stream_actor(owner_actor_id="learner_a",internship_id="vi_1",scenario_actor_id="actor_supervisor",learner_message="Hello",task_id="task_one")]
        owner,internship,row=sink.rows[-1]
        self.assertEqual((owner,internship),("learner_a","vi_1"))
        for key in ("invocation_id","scenario_version_id","model_role","actor_id","task_id","provider","model_id","profile_id","prompt_version","context_hash","status","first_token_ms","total_ms"):
            self.assertIn(key,row)
        dumped=str(row).lower()
        self.assertNotIn("secret-never-audited",dumped)
        self.assertNotIn("api_key",dumped)
        self.assertNotIn("chain_of_thought",dumped)
        self.assertNotIn("scratchpad",dumped)

    def test_phase3_migration_and_worker_are_metadata_only_owner_bound(self):
        migration=(ROOT/"cloudflare/migrations/0009_virtual_internship_phase3_ai.sql").read_text()
        worker=(ROOT/"cloudflare/src/virtual_internship_phase3.ts").read_text()
        persistence=(ROOT/"railway/murikah_persistence.py").read_text()
        self.assertIn("CREATE TABLE IF NOT EXISTS internship_ai_invocations",migration)
        self.assertIn("idx_internship_ai_invocations_internship_time",migration)
        self.assertIn("idx_internship_ai_invocations_role_time",migration)
        self.assertIn("idx_internship_ai_invocations_actor_time",migration)
        self.assertNotIn("chain_of_thought TEXT",migration)
        self.assertNotIn("raw_prompt",migration)
        self.assertNotIn("raw_response",migration)
        self.assertIn("WHERE id = ? AND learner_id = ?",worker)
        self.assertIn("forbidden",worker)
        self.assertIn("def internship_ai_invocation_record(",persistence)

    def test_phase1_duration_and_phase2_state_authority_are_not_in_ai_outputs(self):
        all_ai="\n".join(p.read_text() for p in (ROOT/"railway/virtual_internship/ai").glob("*.py"))
        for forbidden in ("minimum_duration_days =","scenario_version_id =","learner_id =","owner_id =","patch_scenario","execute_sql"):
            self.assertNotIn(forbidden,all_ai)
        self.assertIn("record_decision(",all_ai)
        self.assertIn("state_service.evaluate(",all_ai)


if __name__=="__main__": unittest.main()
